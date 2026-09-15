import { toSql } from 'pgvector'
import type { Chunk, Department } from './corpus.js'

/**
 * 向量索引的端口与两个实现（内存 / pgvector）。
 *
 * 这个文件是从 D13 的 `store.ts` 复制过来的，**只加了一件事：`tenant_id` 这一列，
 * 以及把它和部门谓词一起写进同一条查询**。权限过滤的做法一个字都没改——
 * D13 已经论证过为什么必须下推，本天不重讲，只是把谓词从一个变成两个。
 *
 * 两个实现的语义必须一致：同一批向量、同一个范围，排出来的名次逐条相同。
 * 自测第七项就在验这件事——它是「内存版可以拿来做评估」这个说法的全部依据。
 */

/** 检索范围。**tenantId 是必填的**，没有「查全部租户」这个选项——那正是事故的形状 */
export interface Scope {
  tenantId: string
  /** 租户内部再按部门收窄（D13 的机制）。不填表示该租户的全部订阅范围 */
  departments?: Department[]
}

export interface VectorHit {
  chunkId: string
  /** 余弦相似度（向量都做过 L2 归一化，内积就是余弦），越大越近 */
  score: number
}

export interface VectorStore {
  readonly kind: string
  init(dimensions: number): Promise<void>
  upsert(rows: Array<{ chunk: Chunk; embedding: number[] }>): Promise<void>
  search(query: number[], scope: Scope, topK: number): Promise<VectorHit[]>
  stats(): Promise<{ tenants: number; chunks: number }>
  close(): Promise<void>
}

export class MemoryVectorStore implements VectorStore {
  readonly kind = 'memory（内存索引 + 全表扫描）'
  private rows = new Map<string, { chunk: Chunk; embedding: number[] }>()

  async init(dimensions: number): Promise<void> {
    void dimensions // 内存实现不用预先声明维度，签名对齐端口即可
    this.rows.clear()
  }

  async upsert(rows: Array<{ chunk: Chunk; embedding: number[] }>): Promise<void> {
    for (const row of rows) this.rows.set(row.chunk.chunkId, row)
  }

  /**
   * **练习 2 挖的就是这个函数。**
   *
   * 正确做法：范围谓词在**打分之前**生效，不在范围里的行根本不参与比较。
   * 错误做法（starter 的默认行为）：先全库排序取前 topK，再把不合规的筛掉——
   * 那时候别的租户的块已经被读进内存、参与过排序了，而且返回条数会莫名其妙地变少。
   */
  async search(query: number[], scope: Scope, topK: number): Promise<VectorHit[]> {
    // 练习 2：把范围谓词挪到打分之前。
    //   现在是「先全库打分排序取前 topK，再把不合规的筛掉」——
    //   别的租户的块已经参与过比较，而且返回条数会莫名其妙地变少
    //   （自测第二项会告诉你少了多少）。
    //   提示：inScope 这个函数已经写好了，问题只在于它被调用得太晚。
    return (
      [...this.rows.values()]
        .map((row) => ({
          chunk: row.chunk,
          chunkId: row.chunk.chunkId,
          score: row.embedding.reduce((sum, x, i) => sum + x * query[i], 0),
        }))
        // 同分按 chunkId 定序，否则换个运行环境名次就可能不一样
        .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
        .slice(0, topK)
        .filter((row) => inScope(row.chunk, scope))
        .map(({ chunkId, score }) => ({ chunkId, score }))
    )
  }

  async stats(): Promise<{ tenants: number; chunks: number }> {
    return {
      tenants: new Set([...this.rows.values()].map((r) => r.chunk.tenantId)).size,
      chunks: this.rows.size,
    }
  }

  async close(): Promise<void> {}
}

/** 范围判定只写一次，两个实现和评估侧共用，避免「SQL 和内存各判各的」 */
export function inScope(chunk: Chunk, scope: Scope): boolean {
  if (chunk.tenantId !== scope.tenantId) return false
  return scope.departments ? scope.departments.includes(chunk.department) : true
}

type Sql = {
  unsafe: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
  end: () => Promise<void>
}

export class PgVectorStore implements VectorStore {
  readonly kind = 'pgvector（PostgreSQL 16 + vector 扩展）'

  private constructor(private readonly sql: Sql) {}

  static async connect(url: string): Promise<PgVectorStore> {
    const { default: postgres } = await import('postgres')
    // onnotice 关掉：建表时的 "table does not exist, skipping" 会把自测输出淹掉
    return new PgVectorStore(postgres(url, { onnotice: () => {} }) as unknown as Sql)
  }

  /**
   * 表名沿用全课口径（documents / chunks / chunk_embeddings）。本天多的只有 tenant_id。
   * 索引建在 (tenant_id, department) 上：谓词要走得动，过滤才谈得上下推。
   */
  async init(dimensions: number): Promise<void> {
    await this.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector')
    await this.sql.unsafe('DROP TABLE IF EXISTS chunk_embeddings, chunks CASCADE')
    await this.sql.unsafe(`
      CREATE TABLE chunks (
        chunk_id   text PRIMARY KEY,
        tenant_id  text NOT NULL,
        doc_id     text NOT NULL,
        department text NOT NULL,
        text       text NOT NULL
      )`)
    await this.sql.unsafe(`
      CREATE TABLE chunk_embeddings (
        chunk_id  text PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
        embedding vector(${dimensions}) NOT NULL
      )`)
    await this.sql.unsafe('CREATE INDEX chunks_scope ON chunks (tenant_id, department)')
  }

  async upsert(rows: Array<{ chunk: Chunk; embedding: number[] }>): Promise<void> {
    for (const { chunk, embedding } of rows) {
      await this.sql.unsafe(
        `INSERT INTO chunks (chunk_id, tenant_id, doc_id, department, text)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (chunk_id) DO UPDATE SET text = EXCLUDED.text`,
        [chunk.chunkId, chunk.tenantId, chunk.docId, chunk.department, chunk.text]
      )
      await this.sql.unsafe(
        `INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES ($1, $2::vector)
         ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [chunk.chunkId, toSql(embedding)]
      )
    }
  }

  /**
   * 两个谓词和排序、LIMIT 写在同一条语句里。数据库先按谓词裁掉行、再排序取前 k，
   * 别的租户的行一次都没被比较过——这正是 D13 讲的「过滤下推」，只是多了一列。
   */
  async search(query: number[], scope: Scope, topK: number): Promise<VectorHit[]> {
    const params: unknown[] = [toSql(query), scope.tenantId]
    let where = 'WHERE c.tenant_id = $2'
    if (scope.departments) {
      params.push(scope.departments)
      where += ' AND c.department = ANY($3)'
    }
    const rows = await this.sql.unsafe(
      `SELECT c.chunk_id, 1 - (e.embedding <=> $1::vector) AS score
         FROM chunk_embeddings e JOIN chunks c ON c.chunk_id = e.chunk_id
         ${where}
        ORDER BY e.embedding <=> $1::vector, c.chunk_id
        LIMIT ${topK}`,
      params
    )
    return rows.map((row) => ({ chunkId: String(row.chunk_id), score: Number(row.score) }))
  }

  async stats(): Promise<{ tenants: number; chunks: number }> {
    const rows = await this.sql.unsafe(
      'SELECT count(DISTINCT tenant_id)::int AS t, count(*)::int AS c FROM chunks'
    )
    return { tenants: Number(rows[0]?.t ?? 0), chunks: Number(rows[0]?.c ?? 0) }
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}

/** 唯一的存储选择点。没配 DATABASE_URL 就走内存实现，业务代码一行不改 */
export async function createVectorStore(): Promise<VectorStore> {
  const url = process.env.DATABASE_URL
  if (!url) return new MemoryVectorStore()
  return PgVectorStore.connect(url)
}
