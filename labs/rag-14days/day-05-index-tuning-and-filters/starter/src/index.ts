// D5 实验（starter）：同一份数据在两种索引与三组参数下的召回与延迟对照，
// 加一份带租户过滤的查询实现。
//
// 全程只依赖一个带 pgvector 的 PostgreSQL；MOCK=1 时 embedding 走确定性哈希向量，
// 不需要网络也不需要 API key。

import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { buildDataset, QUERIES, RARE_TENANT } from './dataset.js'
import { createEmbedBackend } from './embed.js'
import { connect, ensureSchema, formatBytes, indexSize, loadRows, tableSize } from './db.js'
import type { Sql } from './db.js'
import { configureDim, explainScan, recallAt, renderTable, runQuery, sweep } from './bench.js'
import type { SweepResult } from './bench.js'

const SCALE = Number(process.env.SCALE ?? 20000)
const TOP_K = Number(process.env.TOP_K ?? 10)

const report: string[] = []

function say(line = ''): void {
  console.log(line)
  report.push(line)
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`
}

function sweepRows(results: SweepResult[]): string[][] {
  return results.map((r) => [r.label, pct(r.recall), r.returned.toFixed(1), ms(r.p50), ms(r.p95)])
}

const SWEEP_HEADERS = ['配置', '召回率@10', '返回条数', 'p50', 'p95']

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now()
  const value = await fn()
  return [value, performance.now() - started]
}

async function main(): Promise<void> {
  const sql = await connect()
  if (!sql) {
    process.exitCode = 0
    return
  }

  try {
    await runExperiment(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }

  writeFileSync(new URL('../report.md', import.meta.url), `${report.join('\n')}\n`)
  console.log('\n对照报告已写入 report.md')
}

async function runExperiment(sql: Sql): Promise<void> {
  // 后端决定维度：MOCK=1 或 EMBED_BACKEND=mock 走 384 维哈希向量（无 key 也能用真 pgvector），
  // 默认走 OpenAI text-embedding-3-small
  const backend = createEmbedBackend()
  const EMBED_DIM = backend.dimensions
  const embed = backend.embed
  configureDim(EMBED_DIM)
  await sql`create extension if not exists vector`
  const [{ version }] = await sql<{ version: string }[]>`
    select extversion as version from pg_extension where extname = 'vector'
  `
  say(`# D5 索引与过滤对照报告`)
  say()
  say(`- pgvector 扩展：${version}`)
  say(`- 维度：${EMBED_DIM}，距离：余弦（vector_cosine_ops）`)
  say(`- embedding 后端：${backend.name}`)
  say(`- 查询数：${QUERIES.length}，top-k：${TOP_K}，每个配置重复 3 轮取分位数`)
  say()
  say(
    `> HNSW 建图带随机性、延迟受机器负载影响，同一台机器重跑两次召回也会差一两个百分点。` +
      `要看的是趋势与量级，不是小数点。`
  )
  say()
  say(
    `> **starter 里挖了 4 个练习点，下面所有召回率在练习做完之前都不作数。**` +
      `按顺序修：① bench.ts 的 recallAt ② bench.ts 里真值查询要关掉索引扫描` +
      ` ③ index.ts 的 IVFFlat lists ④ index.ts 的迭代扫描模式。`
  )
  say()

  // ── 1. 装数据 ────────────────────────────────────────────────────────────
  const dataset = buildDataset(SCALE)
  say(`## 1. 数据`)
  say()
  const [vectors, embedMs] = await timed(() => embed(dataset.rows.map((r) => r.text)))
  await ensureSchema(sql, EMBED_DIM)
  const [, loadMs] = await timed(() => loadRows(sql, dataset.rows, vectors))
  const bytes = await tableSize(sql)
  const [rare] = await sql<{ n: string }[]>`
    select count(*) as n from chunk_embeddings where tenant_id = ${RARE_TENANT}
  `
  say(
    `真语料块 ${dataset.realCount} 条，合成块补到 ${dataset.rows.length} 条；` +
      `embedding 用时 ${(embedMs / 1000).toFixed(1)} s，入库用时 ${(loadMs / 1000).toFixed(1)} s。`
  )
  say(`表大小 ${formatBytes(bytes)}（不含索引）。稀有租户 ${RARE_TENANT} 占 ${rare.n} 行。`)
  say()

  const queryVectors = await embed(QUERIES)

  // ── 2. 暴力全量比对：既是真值，也是「为什么要索引」的对照 ────────────────
  say(`## 2. 暴力全量比对（真值）`)
  say()
  const truths: string[][] = []
  const filteredTruths: string[][] = []
  const exactLatencies: number[] = []
  for (const vector of queryVectors) {
    const plain = await runQuery(sql, vector, TOP_K, { exact: true })
    truths.push(plain.ids)
    exactLatencies.push(plain.ms)
    const filtered = await runQuery(sql, vector, TOP_K, { exact: true, tenantId: RARE_TENANT })
    filteredTruths.push(filtered.ids)
  }
  exactLatencies.sort((a, b) => a - b)
  const exactP50 = exactLatencies[Math.floor(exactLatencies.length / 2)]
  say(`全表顺序扫描 ${dataset.rows.length} 行，p50 = ${ms(exactP50)}。`)
  say(`它的召回率恒等于 100%，后面所有索引配置的召回都以它为分母。`)
  say()

  // ── 3. HNSW ─────────────────────────────────────────────────────────────
  say(`## 3. HNSW（m = 16，ef_construction = 64）`)
  say()
  const [, hnswBuildMs] = await timed(
    () => sql`
      create index chunks_hnsw on chunk_embeddings
      using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
    `
  )
  const hnswBytes = await indexSize(sql, 'chunks_hnsw')
  say(`建索引用时 ${(hnswBuildMs / 1000).toFixed(1)} s，索引大小 ${formatBytes(hnswBytes)}。`)
  say()
  const hnswSweep: SweepResult[] = []
  for (const ef of [10, 40, 100, 200, 400]) {
    hnswSweep.push(
      await sweep(sql, `ef_search = ${ef}`, queryVectors, truths, TOP_K, {
        settings: { 'hnsw.ef_search': String(ef) },
      })
    )
  }
  say('```text')
  say(renderTable(SWEEP_HEADERS, sweepRows(hnswSweep)))
  say('```')
  say()

  // ── 4. 带过滤的查询：漏召回与迭代扫描 ────────────────────────────────────
  say(`## 4. 带租户过滤（tenant_id = ${RARE_TENANT}，占全表 1%）`)
  say()
  const filterPlan = await explainScan(sql, queryVectors[0], TOP_K, {
    tenantId: RARE_TENANT,
    settings: { 'hnsw.ef_search': '40' },
  })
  say(`执行计划：\`${filterPlan}\``)
  say()
  const filterSweep: SweepResult[] = []
  // 练习 4：把漏召回修好。
  // 三行现在都是 off，所以三行的召回率一模一样、都很低——问题还在那儿。
  // 提示：pgvector 0.8.0 起有迭代扫描，取值见 hnsw.iterative_scan；
  // 两种排序模式的召回和延迟不一样，两种都跑一遍再决定用哪个。
  for (const [label, mode] of [
    ['iterative_scan = off（默认）', 'off'],
    ['iterative_scan = relaxed_order', 'off'],
    ['iterative_scan = strict_order', 'off'],
  ] as const) {
    filterSweep.push(
      await sweep(sql, label, queryVectors, filteredTruths, TOP_K, {
        tenantId: RARE_TENANT,
        settings: { 'hnsw.ef_search': '40', 'hnsw.iterative_scan': mode },
      })
    )
  }
  say('```text')
  say(renderTable(SWEEP_HEADERS, sweepRows(filterSweep)))
  say('```')
  say()
  say(
    `默认配置下每次只返回 ${filterSweep[0].returned.toFixed(1)} 条——` +
      `不是数据库里没有，是 ef_search 取回的 40 个候选里几乎没有这个租户的行，过滤发生在索引扫描之后。`
  )
  say()

  // 部分索引：只有少数几个取值时的另一条路
  const [, partialBuildMs] = await timed(() =>
    // 索引谓词里不能放绑定参数，只能是常量
    sql.unsafe(
      `create index chunks_hnsw_rare on chunk_embeddings
       using hnsw (embedding vector_cosine_ops) where (tenant_id = '${RARE_TENANT}')`
    )
  )
  const partialBytes = await indexSize(sql, 'chunks_hnsw_rare')
  const partialSweep = await sweep(
    sql,
    '部分索引（默认 ef_search = 40）',
    queryVectors,
    filteredTruths,
    TOP_K,
    { tenantId: RARE_TENANT, settings: { 'hnsw.ef_search': '40' } }
  )
  say(
    `另一条路是给这个租户单独建部分索引：建索引 ${(partialBuildMs / 1000).toFixed(1)} s，` +
      `只占 ${formatBytes(partialBytes)}，不开迭代扫描的召回就是 ${pct(partialSweep.recall)}，` +
      `p50 = ${ms(partialSweep.p50)}。代价是租户数量一多，索引数量就跟着爆炸。`
  )
  say()
  await sql`drop index chunks_hnsw_rare`

  // ── 5. halfvec ──────────────────────────────────────────────────────────
  say(`## 5. 半精度（halfvec）`)
  say()
  const [sizes] = await sql.unsafe<{ full: number; half: number }[]>(
    `select pg_column_size(embedding) as full,
            pg_column_size(embedding::halfvec(${EMBED_DIM})) as half
     from chunk_embeddings limit 1`
  )
  const [, halfBuildMs] = await timed(() =>
    sql.unsafe(
      `create index chunks_hnsw_half on chunk_embeddings
       using hnsw ((embedding::halfvec(${EMBED_DIM})) halfvec_cosine_ops)
       with (m = 16, ef_construction = 64)`
    )
  )
  const halfBytes = await indexSize(sql, 'chunks_hnsw_half')
  say(
    `单行向量列 ${sizes.full} 字节 → 半精度 ${sizes.half} 字节；` +
      `索引 ${formatBytes(hnswBytes)} → ${formatBytes(halfBytes)}，` +
      `建索引 ${(hnswBuildMs / 1000).toFixed(1)} s → ${(halfBuildMs / 1000).toFixed(1)} s。`
  )
  say()
  const halfSweep: SweepResult[] = []
  for (const ef of [40, 100, 200]) {
    halfSweep.push(
      await sweep(sql, `halfvec ef_search = ${ef}`, queryVectors, truths, TOP_K, {
        mode: 'halfvec',
        settings: { 'hnsw.ef_search': String(ef) },
      })
    )
  }
  say('```text')
  say(renderTable(SWEEP_HEADERS, sweepRows(halfSweep)))
  say('```')
  say()
  say(`真值仍然是全精度的暴力比对结果，所以这里的召回损失就是量化本身的损失。`)
  say()
  await sql`drop index chunks_hnsw_half`

  // ── 5b. 二值量化 ────────────────────────────────────────────────────────
  say(`## 5b. 二值量化（bit + 汉明距离）`)
  say()
  const [binSizes] = await sql.unsafe<{ bits: number }[]>(
    `select pg_column_size(binary_quantize(embedding)::bit(${EMBED_DIM})) as bits
     from chunk_embeddings limit 1`
  )
  const [, binBuildMs] = await timed(() =>
    sql.unsafe(
      `create index chunks_hnsw_bin on chunk_embeddings
       using hnsw ((binary_quantize(embedding)::bit(${EMBED_DIM})) bit_hamming_ops)
       with (m = 16, ef_construction = 64)`
    )
  )
  const binBytes = await indexSize(sql, 'chunks_hnsw_bin')
  say(
    `单行向量列 ${sizes.full} 字节 → 二值 ${binSizes.bits} 字节；` +
      `索引 ${formatBytes(hnswBytes)} → ${formatBytes(binBytes)}，` +
      `建索引 ${(hnswBuildMs / 1000).toFixed(1)} s → ${(binBuildMs / 1000).toFixed(1)} s。`
  )
  say()
  const binSweep: SweepResult[] = [
    await sweep(sql, '二值，直接取前 10', queryVectors, truths, TOP_K, {
      mode: 'binary',
      settings: { 'hnsw.ef_search': '40' },
    }),
    await sweep(sql, '二值粗筛 100 条后重排', queryVectors, truths, TOP_K, {
      mode: 'binary-rerank',
      rerankFrom: 100,
      settings: { 'hnsw.ef_search': '200' },
    }),
    await sweep(sql, '二值粗筛 500 条后重排', queryVectors, truths, TOP_K, {
      mode: 'binary-rerank',
      rerankFrom: 500,
      settings: { 'hnsw.ef_search': '600' },
    }),
  ]
  say('```text')
  say(renderTable(SWEEP_HEADERS, sweepRows(binSweep)))
  say('```')
  say()
  say(
    `粗筛窗口从 100 放到 500，召回从 ${pct(binSweep[1].recall)} 涨到 ${pct(binSweep[2].recall)}——` +
      `这就是「二值粗筛 + 原始向量精排」的机制：损失靠加宽候选窗口买回来。`
  )
  say()
  say(
    `**这一组的绝对值不要外推。** MOCK 的哈希向量非常稀疏，短查询有九成以上的维度是 0，` +
      `而二值化只保留符号位，零和负数都会变成 0，稀疏向量的信息几乎被抹平。` +
      `真实的稠密 embedding 上二值量化的损失远没有这么大。` +
      `这恰恰是本天最该记住的一条：**换量化方案必须在你自己的数据分布上重新量一次召回。**`
  )
  say()
  await sql`drop index chunks_hnsw_bin`
  await sql`drop index chunks_hnsw`

  // ── 6. IVFFlat ──────────────────────────────────────────────────────────
  // 练习 3：IVFFlat 的 lists 该取多少？
  // 提示：pgvector 给的起点是「不超过 100 万行取 rows / 1000，超过取 sqrt(rows)」。
  // 现在写死成 1 意味着整张表只有一个列表——probes 取多少召回都是 100%，
  // 延迟也等于全表扫描，这个索引等于白建。
  const lists = 1
  say(`## 6. IVFFlat（lists = ${lists}）`)
  say()
  const [, ivfBuildMs] = await timed(
    () => sql`
      create index chunks_ivf on chunk_embeddings
      using ivfflat (embedding vector_cosine_ops) with (lists = ${sql.unsafe(String(lists))})
    `
  )
  const ivfBytes = await indexSize(sql, 'chunks_ivf')
  say(`建索引用时 ${(ivfBuildMs / 1000).toFixed(1)} s，索引大小 ${formatBytes(ivfBytes)}。`)
  say()
  const ivfSweep: SweepResult[] = []
  const probeGrid = [1, 2, Math.round(Math.sqrt(lists)), 10, lists]
  for (const probes of [...new Set(probeGrid)].sort((a, b) => a - b)) {
    ivfSweep.push(
      await sweep(sql, `probes = ${probes}`, queryVectors, truths, TOP_K, {
        settings: { 'ivfflat.probes': String(probes) },
      })
    )
  }
  say('```text')
  say(renderTable(SWEEP_HEADERS, sweepRows(ivfSweep)))
  say('```')
  say()

  const ivfFilter = await sweep(
    sql,
    `probes = ${Math.round(Math.sqrt(lists))}，iterative_scan = off`,
    queryVectors,
    filteredTruths,
    TOP_K,
    {
      tenantId: RARE_TENANT,
      settings: {
        'ivfflat.probes': String(Math.round(Math.sqrt(lists))),
        'ivfflat.iterative_scan': 'off',
      },
    }
  )
  const ivfFilterFixed = await sweep(
    sql,
    `probes = ${Math.round(Math.sqrt(lists))}，iterative_scan = relaxed_order`,
    queryVectors,
    filteredTruths,
    TOP_K,
    {
      tenantId: RARE_TENANT,
      settings: {
        'ivfflat.probes': String(Math.round(Math.sqrt(lists))),
        'ivfflat.iterative_scan': 'relaxed_order',
      },
    }
  )
  say(`IVFFlat 上的同一个过滤场景：`)
  say()
  say('```text')
  say(renderTable(SWEEP_HEADERS, sweepRows([ivfFilter, ivfFilterFixed])))
  say('```')
  say()
  say(
    `注意这里返回条数是够的，召回却只有 ${pct(ivfFilter.recall)}，而且开迭代扫描也不变。` +
      `迭代扫描修的是「结果条数不够」那一种漏召回；` +
      `「条数够了但排在前面的不是真正的最近邻」是另一种，只能靠加 probes 或 ef_search 解决。`
  )
  say()
  await sql`drop index chunks_ivf`

  // ── 7. 选型备忘 ─────────────────────────────────────────────────────────
  const hnswAt40 = hnswSweep.find((r) => r.label === 'ef_search = 40')
  say(`## 7. 一页选型备忘（下面每条结论都只在本次跑出的规模下成立）`)
  say()
  say(`数据规模：${dataset.rows.length} 行 × ${EMBED_DIM} 维，单机 Docker，余弦距离。`)
  say()
  say(
    `1. 暴力比对 p50 = ${ms(exactP50)}，HNSW 默认参数 p50 = ${ms(hnswAt40?.p50 ?? 0)}。` +
      `这个差距会随行数线性拉大——两万行还能忍，两百万行就不能。`
  )
  say(
    `2. HNSW 建索引 ${(hnswBuildMs / 1000).toFixed(1)} s / ${formatBytes(hnswBytes)}，` +
      `IVFFlat 建索引 ${(ivfBuildMs / 1000).toFixed(1)} s / ${formatBytes(ivfBytes)}。` +
      `写入频繁、能接受召回略低时选 IVFFlat；查询质量优先、数据相对静态时选 HNSW。`
  )
  say(
    `3. 半精度把每行向量从 ${sizes.full} 字节压到 ${sizes.half} 字节，同参数召回 ` +
      `${pct(hnswAt40?.recall ?? 0)} → ${pct(halfSweep[0].recall)}；` +
      `二值压到 ${binSizes.bits} 字节（索引 ${formatBytes(binBytes)}），` +
      `但在 mock 的稀疏向量上召回只剩 ${pct(binSweep[0].recall)}。` +
      `内存吃紧就换，换完必须在自己的数据上重新量召回。`
  )
  say(
    `4. 带过滤的查询默认会漏：本次实测 1% 的租户过滤下只返回 ` +
      `${filterSweep[0].returned.toFixed(1)} / ${TOP_K} 条。` +
      `迭代扫描能修好，代价是延迟从 ${ms(filterSweep[0].p50)} 涨到 ${ms(filterSweep[2].p50)}。`
  )
  say(
    `5. 租户少且固定就用部分索引，租户多就用列表分区；只有当过滤组合复杂到` +
      `两条路都走不通时，才值得把向量搬去专用向量库。`
  )
  say()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
