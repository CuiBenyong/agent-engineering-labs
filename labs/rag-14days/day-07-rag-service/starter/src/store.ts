import postgres from 'postgres'
import { toSql } from 'pgvector'
import type { Chunk, Department, ParsedDoc } from './pipeline'
import { cosine } from './embed'

/**
 * 存储层。摄取链路往里写，查询链路往外读——**这是两条链路唯一共享的东西**，
 * 所以它的接口必须先定下来，再谈两边各自怎么实现。
 *
 * 两个实现：
 * - PgStore：真实的 PostgreSQL 16 + pgvector，`DATABASE_URL` 存在时使用
 * - MemoryStore：全在内存里，没有 DATABASE_URL 时使用，让读者零依赖就能跑通整条链路
 *
 * MemoryStore 不是「假装写成功」的桩，它把语义真的实现了一遍（包括余弦排序、
 * 包括按 doc 覆盖旧块）。区别只在性能：它全表扫，PgStore 走 HNSW 索引。
 */
export interface StoredChunk extends Chunk {
  seq: number
}

export interface VectorHit {
  chunkId: string
  score: number
}

export interface Store {
  readonly kind: 'postgres' | 'memory'
  /** 可重复执行的迁移。compose 的 initdb.d 已经跑过一遍，这里是补丁与兜底 */
  init(): Promise<void>
  /** 一篇文档连同它的块一次性替换掉。D13 会把它拆成新增 / 修改 / 删除三条路径 */
  replaceDoc(doc: ParsedDoc, chunks: Chunk[], vectors: number[][], model: string): Promise<void>
  listChunks(): Promise<StoredChunk[]>
  getChunk(chunkId: string): Promise<StoredChunk | null>
  vectorSearch(query: number[], topK: number): Promise<VectorHit[]>
  stats(): Promise<{ docs: number; chunks: number }>
  close(): Promise<void>
}

function seqOf(chunkId: string): number {
  return Number(chunkId.split('#c')[1] ?? 0)
}

class MemoryStore implements Store {
  readonly kind = 'memory'
  private chunks = new Map<string, StoredChunk>()
  private vectors = new Map<string, number[]>()
  private docs = new Set<string>()

  async init(): Promise<void> {}

  async replaceDoc(doc: ParsedDoc, chunks: Chunk[], vectors: number[][]): Promise<void> {
    for (const [id, c] of this.chunks) if (c.docId === doc.docId) this.chunks.delete(id)
    this.docs.add(doc.docId)
    chunks.forEach((chunk, i) => {
      this.chunks.set(chunk.chunkId, { ...chunk, seq: seqOf(chunk.chunkId) })
      this.vectors.set(chunk.chunkId, vectors[i])
    })
  }

  async listChunks(): Promise<StoredChunk[]> {
    return [...this.chunks.values()].sort((a, b) => a.chunkId.localeCompare(b.chunkId))
  }

  async getChunk(chunkId: string): Promise<StoredChunk | null> {
    return this.chunks.get(chunkId) ?? null
  }

  async vectorSearch(query: number[], topK: number): Promise<VectorHit[]> {
    return (
      [...this.vectors.entries()]
        .map(([chunkId, v]) => ({ chunkId, score: cosine(query, v) }))
        // 同分时按 chunkId 定序：不给决胜键的话，两次运行的排序可能不一样
        .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
        .slice(0, topK)
    )
  }

  async stats(): Promise<{ docs: number; chunks: number }> {
    return { docs: this.docs.size, chunks: this.chunks.size }
  }

  async close(): Promise<void> {}
}

class PgStore implements Store {
  readonly kind = 'postgres'
  private sql: postgres.Sql

  constructor(url: string) {
    this.sql = postgres(url, { onnotice: () => {} })
  }

  async init(): Promise<void> {
    const { sql } = this
    await sql`CREATE EXTENSION IF NOT EXISTS vector`
    await sql`CREATE TABLE IF NOT EXISTS documents (
      doc_id text PRIMARY KEY, title text NOT NULL, department text NOT NULL,
      updated_at date NOT NULL, content_hash text NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now())`
    await sql`CREATE TABLE IF NOT EXISTS chunks (
      chunk_id text PRIMARY KEY,
      doc_id text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
      seq integer NOT NULL, text text NOT NULL,
      heading_path text[] NOT NULL DEFAULT '{}', page integer,
      department text NOT NULL, updated_at date NOT NULL, content_hash text NOT NULL)`
    await sql`CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks (doc_id)`
    await sql`CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id text PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
      model text NOT NULL, embedding vector(384) NOT NULL)`
    await sql`CREATE INDEX IF NOT EXISTS chunk_embeddings_hnsw
      ON chunk_embeddings USING hnsw (embedding vector_cosine_ops)`
  }

  async replaceDoc(
    doc: ParsedDoc,
    chunks: Chunk[],
    vectors: number[][],
    model: string
  ): Promise<void> {
    // 一篇文档的替换必须是一个事务：删了旧块却没写进新块，等于这篇文档从库里消失了。
    // 生产上这一段还要处理并发摄取同一篇的情况，那是 D13 的事。
    await this.sql.begin(async (sql) => {
      await sql`INSERT INTO documents (doc_id, title, department, updated_at, content_hash)
        VALUES (${doc.docId}, ${doc.title}, ${doc.department}, ${doc.updatedAt}, ${doc.contentHash})
        ON CONFLICT (doc_id) DO UPDATE SET title = EXCLUDED.title,
          department = EXCLUDED.department, updated_at = EXCLUDED.updated_at,
          content_hash = EXCLUDED.content_hash, ingested_at = now()`
      await sql`DELETE FROM chunks WHERE doc_id = ${doc.docId}` // 向量表靠 ON DELETE CASCADE 跟着删
      for (let i = 0; i < chunks.length; i += 1) {
        const c = chunks[i]
        await sql`INSERT INTO chunks (chunk_id, doc_id, seq, text, heading_path, page,
            department, updated_at, content_hash)
          VALUES (${c.chunkId}, ${c.docId}, ${seqOf(c.chunkId)}, ${c.text},
            ${sql.array(c.headingPath)}, ${c.page}, ${c.department}, ${c.updatedAt}, ${c.contentHash})`
        await sql`INSERT INTO chunk_embeddings (chunk_id, model, embedding)
          VALUES (${c.chunkId}, ${model}, ${toSql(vectors[i])})`
      }
    })
  }

  private toChunk(row: postgres.Row): StoredChunk {
    return {
      chunkId: row.chunk_id as string,
      docId: row.doc_id as string,
      seq: row.seq as number,
      text: row.text as string,
      headingPath: row.heading_path as string[],
      page: row.page as number | null,
      department: row.department as Department,
      updatedAt: new Date(row.updated_at as string).toISOString().slice(0, 10),
      contentHash: row.content_hash as string,
    }
  }

  async listChunks(): Promise<StoredChunk[]> {
    const rows = await this.sql`SELECT * FROM chunks ORDER BY chunk_id`
    return rows.map((r) => this.toChunk(r))
  }

  async getChunk(chunkId: string): Promise<StoredChunk | null> {
    const rows = await this.sql`SELECT * FROM chunks WHERE chunk_id = ${chunkId}`
    return rows.length ? this.toChunk(rows[0]) : null
  }

  async vectorSearch(query: number[], topK: number): Promise<VectorHit[]> {
    // <=> 是余弦距离，1 - 距离才是相似度。三个运算符分别对应哪种距离，见 D2
    const rows = await this.sql`
      SELECT chunk_id, 1 - (embedding <=> ${toSql(query)}) AS score
      FROM chunk_embeddings
      ORDER BY embedding <=> ${toSql(query)}, chunk_id
      LIMIT ${topK}`
    return rows.map((r) => ({ chunkId: r.chunk_id as string, score: Number(r.score) }))
  }

  async stats(): Promise<{ docs: number; chunks: number }> {
    const [d] = await this.sql`SELECT count(*)::int AS n FROM documents`
    const [c] = await this.sql`SELECT count(*)::int AS n FROM chunks`
    return { docs: d.n as number, chunks: c.n as number }
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}

/**
 * 唯一的选择点。有 DATABASE_URL 就连真库，没有就用内存版——
 * 上面两个类之外的代码一行都不知道自己在跟谁说话。
 */
export function createStore(): Store {
  const url = process.env.DATABASE_URL
  return url ? new PgStore(url) : new MemoryStore()
}
