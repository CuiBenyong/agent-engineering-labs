import { toSql } from 'pgvector'
import type { Sql } from './db.js'
import { MOCK_DIM } from './embed.js'

// 向量维度由 embedding 后端决定（mock 384、OpenAI 默认 1536），
// 建表之后由 index.ts 调一次 configureDim，后面所有 SQL 片段都用它
let DIM = MOCK_DIM

export function configureDim(dimensions: number): void {
  DIM = dimensions
}

/** 同一份数据的四种查法：全精度、半精度、二值、二值粗筛后用全精度重排 */
export type QueryMode = 'vector' | 'halfvec' | 'binary' | 'binary-rerank'

export interface QueryOptions {
  /** 每次查询前用 SET LOCAL 打进事务的参数，例如 hnsw.ef_search */
  settings?: Record<string, string>
  /** 带上租户过滤条件 */
  tenantId?: string
  /** 关掉索引扫描，走全表暴力比对，用来算真值 */
  exact?: boolean
  mode?: QueryMode
  /** 二值粗筛取多少条再重排 */
  rerankFrom?: number
}

export interface QueryResult {
  ids: string[]
  ms: number
}

// 余弦距离。哈希向量与 text-embedding-3-small 都做过 L2 归一化，余弦是本课默认口径
const full = () => `embedding <=> $1::vector(${DIM})`
const half = () => `embedding::halfvec(${DIM}) <=> $1::halfvec(${DIM})`
// 二值量化比的是汉明距离：每一维只留符号位，一维压成一个比特
const binary = () =>
  `binary_quantize(embedding)::bit(${DIM}) <~> binary_quantize($1::vector(${DIM}))::bit(${DIM})`

function buildSelect(k: number, where: string, options: QueryOptions): string {
  const mode = options.mode ?? 'vector'
  if (mode === 'binary-rerank') {
    const wide = options.rerankFrom ?? 10 * k
    // 先用便宜的汉明距离粗筛一批，再用原始向量在这一小批里精排——这是补回量化损失的标准做法
    return `select chunk_id from (
              select chunk_id, embedding from chunk_embeddings ${where}
              order by ${binary()} limit ${wide}
            ) coarse order by ${full()} limit ${k}`
  }
  const expr = mode === 'halfvec' ? half() : mode === 'binary' ? binary() : full()
  return `select chunk_id, ${expr} as distance
          from chunk_embeddings ${where}
          order by distance limit ${k}`
}

export async function runQuery(
  sql: Sql,
  vector: number[],
  k: number,
  options: QueryOptions = {}
): Promise<QueryResult> {
  const params: string[] = [toSql(vector) as string]
  let where = ''
  if (options.tenantId) {
    params.push(options.tenantId)
    where = `where tenant_id = $2`
  }
  const text = buildSelect(k, where, options)

  return sql.begin(async (tx) => {
    if (options.exact) {
      // 逼 planner 走顺序扫描：这就是「暴力全量比对」，也是我们的召回真值
      await tx.unsafe('set local enable_indexscan = off')
      await tx.unsafe('set local enable_bitmapscan = off')
    }
    for (const [key, value] of Object.entries(options.settings ?? {})) {
      await tx.unsafe(`set local ${key} = ${value}`)
    }
    const started = performance.now()
    const rows = await tx.unsafe<{ chunk_id: string }[]>(text, params)
    const ms = performance.now() - started
    return { ids: rows.map((row) => row.chunk_id), ms }
  }) as Promise<QueryResult>
}

/** 看 planner 到底走了哪条路。带过滤的查询最容易「以为走了索引，其实退回了全表扫描」 */
export async function explainScan(
  sql: Sql,
  vector: number[],
  k: number,
  options: QueryOptions = {}
): Promise<string> {
  const params: string[] = [toSql(vector) as string]
  let where = ''
  if (options.tenantId) {
    params.push(options.tenantId)
    where = `where tenant_id = $2`
  }
  const text = `explain (costs off) ${buildSelect(k, where, options)}`
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(options.settings ?? {})) {
      await tx.unsafe(`set local ${key} = ${value}`)
    }
    const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(text, params)
    // 计划里会把整个查询向量原样打出来，384 维刷屏，折叠掉
    return rows.map((row) => row['QUERY PLAN'].trim().replace(/'\[[^\]]*\]'/g, "'[…]'")).join(' / ')
  }) as Promise<string>
}

export interface SweepResult {
  label: string
  recall: number
  returned: number
  p50: number
  p95: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

export function recallAt(returned: string[], truth: string[]): number {
  if (truth.length === 0) return 1
  const truthSet = new Set(truth)
  let hit = 0
  for (const id of returned) if (truthSet.has(id)) hit += 1
  return hit / truth.length
}

/** 同一批查询跑 repeats 遍，取召回均值与延迟分位数 */
export async function sweep(
  sql: Sql,
  label: string,
  vectors: number[][],
  truths: string[][],
  k: number,
  options: QueryOptions,
  repeats = 3
): Promise<SweepResult> {
  const latencies: number[] = []
  let recallSum = 0
  let returnedSum = 0
  for (let round = 0; round < repeats; round += 1) {
    for (let i = 0; i < vectors.length; i += 1) {
      const result = await runQuery(sql, vectors[i], k, options)
      latencies.push(result.ms)
      if (round === 0) {
        recallSum += recallAt(result.ids, truths[i])
        returnedSum += result.ids.length
      }
    }
  }
  latencies.sort((a, b) => a - b)
  return {
    label,
    recall: recallSum / vectors.length,
    returned: returnedSum / vectors.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
  }
}

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? '')))
  )
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell + ' '.repeat(widths[i] - displayWidth(cell))).join('  ')
  const separator = widths.map((w) => '-'.repeat(w)).join('  ')
  return [line(headers), separator, ...rows.map(line)].join('\n')
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += /[一-鿿：（）]/.test(char) ? 2 : 1
  return width
}
