import { toSql } from 'pgvector'
import type { Chunk, Department } from './chunk.js'

/**
 * 索引存储的端口与两个实现：
 *
 *   PgIndex     —— PostgreSQL 16 + pgvector，表名沿用全课口径 documents / chunks / chunk_embeddings
 *   MemoryIndex —— 内存实现，MOCK=1 或没配 DATABASE_URL 时用
 *
 * 两个实现的**语义**必须一样：同一批向量、同一个权限范围，排出来的名次必须一致。
 * 本天关心的是三件事，两个实现都要真的做到：
 *
 *   1. 删除一篇文档，它的块与向量必须一起消失（SQL 靠 ON DELETE CASCADE，内存版靠手写）
 *   2. 权限过滤**下推到查询里**，而不是查完再筛
 *   3. 每次检索报出「扫了多少行」，好让行级过滤与索引隔离两种做法能被量出来
 */

export interface DocRow {
  docId: string
  title: string
  department: Department
  updatedAt: string
  contentHash: string
  /** 去重之后指向的正本；自己就是正本时为 null */
  canonicalOf: string | null
}

export interface EmbeddedChunk {
  chunk: Chunk
  embedding: number[]
}

export interface SearchOptions {
  topK: number
  /**
   * 允许访问的部门。**undefined 表示不过滤**——生产上这应该是一个需要显式开启的调试开关，
   * 而不是默认值，否则一次忘传参数就是一次越权检索。
   */
  departments?: Department[]
  /** 查哪一列向量：迁移期间新旧两套向量并存 */
  column?: 'v1' | 'v2'
}

export interface Hit {
  rank: number
  chunkId: string
  docId: string
  title: string
  department: Department
  text: string
  /** 余弦距离，越小越近 */
  distance: number
}

export interface SearchResult {
  hits: Hit[]
  /** 这次检索实际比较了多少行向量 */
  scanned: number
  /**
   * 为了凑出那些行，一共**碰过**多少行。行级过滤与索引隔离的差别全在这个数上：
   * 两者比较的向量条数一样，但行级过滤要先把整张表过一遍谓词才知道哪些行该比，
   * 索引隔离直接拿对应的那份索引，越权的数据一次都没被读到。
   */
  examined: number
}

export interface IndexStore {
  readonly kind: string
  init(dimensions: number): Promise<void>
  /** 当前索引里每篇文档的指纹，增量同步的对账基准 */
  fingerprints(): Promise<Map<string, DocRow>>
  upsertDoc(row: DocRow): Promise<void>
  /** 整篇替换：先删掉这篇的旧块与旧向量，再写新的。这是「修改」在索引侧的唯一正确做法 */
  replaceChunks(docId: string, rows: EmbeddedChunk[]): Promise<void>
  /** 删除一篇文档，连带它的块与向量 */
  deleteDoc(docId: string): Promise<void>
  search(query: number[], opts: SearchOptions): Promise<SearchResult>
  /** 迁移用：给一批块写入第二套向量 */
  writeV2(rows: Array<{ chunkId: string; embedding: number[] }>): Promise<void>
  stats(): Promise<{ docs: number; chunks: number; embeddings: number }>
  close(): Promise<void>
}

/** 归一化过的向量，余弦相似度就是内积，距离 = 1 - 内积 */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return 1 - dot
}

interface MemoryRow {
  chunk: Chunk
  v1: number[]
  v2: number[] | null
}

export class MemoryIndex implements IndexStore {
  readonly kind: string
  private docs = new Map<string, DocRow>()
  private rows = new Map<string, MemoryRow>()
  /** 索引隔离模式：按部门分桶，检索时只扫本桶 */
  private buckets = new Map<Department, Set<string>>()

  constructor(private readonly isolated = false) {
    this.kind = isolated ? 'memory（按部门分桶的隔离索引）' : 'memory（单一索引 + 行级过滤）'
  }

  async init(dimensions = 0): Promise<void> {
    void dimensions // 内存实现不需要预先声明维度，签名对齐端口即可
    this.docs.clear()
    this.rows.clear()
    this.buckets.clear()
  }

  async fingerprints(): Promise<Map<string, DocRow>> {
    return new Map(this.docs)
  }

  async upsertDoc(row: DocRow): Promise<void> {
    this.docs.set(row.docId, row)
  }

  private bucket(dept: Department): Set<string> {
    let set = this.buckets.get(dept)
    if (!set) {
      set = new Set()
      this.buckets.set(dept, set)
    }
    return set
  }

  private dropChunks(docId: string): void {
    for (const [chunkId, row] of this.rows) {
      if (row.chunk.docId !== docId) continue
      this.rows.delete(chunkId)
      this.buckets.get(row.chunk.department)?.delete(chunkId)
    }
  }

  async replaceChunks(docId: string, rows: EmbeddedChunk[]): Promise<void> {
    this.dropChunks(docId) // 先删后插：漏掉这一步，改短了的文档会在索引里留下多余的尾巴
    for (const { chunk, embedding } of rows) {
      this.rows.set(chunk.chunkId, { chunk, v1: embedding, v2: null })
      this.bucket(chunk.department).add(chunk.chunkId)
    }
  }

  async deleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId)
    this.dropChunks(docId)
  }

  async search(query: number[], opts: SearchOptions): Promise<SearchResult> {
    const column = opts.column ?? 'v1'
    // 过滤发生在**打分之前**：不该看见的行根本不参与比较，也就无从泄露
    let candidates: string[]
    let examined: number
    if (!opts.departments) {
      candidates = [...this.rows.keys()]
      examined = candidates.length
    } else if (this.isolated) {
      // 索引隔离：直接拿对应的桶，压根不碰别的部门的数据
      candidates = opts.departments.flatMap((d) => [...this.bucket(d)])
      examined = candidates.length
    } else {
      // 行级过滤：单一索引 + 一个谓词。比较的向量少了，但为了找出这些行，整张表都得过一遍
      candidates = [...this.rows.entries()]
        .filter(([, row]) => opts.departments?.includes(row.chunk.department))
        .map(([id]) => id)
      examined = this.rows.size
    }

    const scored = candidates.map((id) => {
      const row = this.rows.get(id) as MemoryRow
      const vec = column === 'v2' ? (row.v2 ?? row.v1) : row.v1
      return { row, distance: cosineDistance(query, vec) }
    })
    const hits = scored
      // 同距离时按 chunkId 定序，否则换个运行环境名次就可能不一样
      .sort(
        (a, b) => a.distance - b.distance || a.row.chunk.chunkId.localeCompare(b.row.chunk.chunkId)
      )
      .slice(0, opts.topK)
      .map((item, i) => ({
        rank: i + 1,
        chunkId: item.row.chunk.chunkId,
        docId: item.row.chunk.docId,
        title: this.docs.get(item.row.chunk.docId)?.title ?? item.row.chunk.docId,
        department: item.row.chunk.department,
        text: item.row.chunk.text,
        distance: Number(item.distance.toFixed(6)),
      }))
    return { hits, scanned: candidates.length, examined }
  }

  async writeV2(rows: Array<{ chunkId: string; embedding: number[] }>): Promise<void> {
    for (const { chunkId, embedding } of rows) {
      const row = this.rows.get(chunkId)
      if (row) row.v2 = embedding
    }
  }

  async stats(): Promise<{ docs: number; chunks: number; embeddings: number }> {
    return { docs: this.docs.size, chunks: this.rows.size, embeddings: this.rows.size }
  }

  async close(): Promise<void> {}
}

type Sql = {
  unsafe: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
  end: () => Promise<void>
}

export class PgIndex implements IndexStore {
  readonly kind = 'pgvector（PostgreSQL 16 + vector 扩展）'

  private constructor(private readonly sql: Sql) {}

  static async connect(url: string): Promise<PgIndex> {
    const { default: postgres } = await import('postgres')
    // onnotice 关掉：建表时的 "table does not exist, skipping" 会把自测输出淹掉
    return new PgIndex(postgres(url, { onnotice: () => {} }) as unknown as Sql)
  }

  /**
   * 表名沿用全课口径。今天多了三列：
   *   documents.content_hash   增量同步的对账依据
   *   documents.canonical_of   去重之后指向正本
   *   chunk_embeddings.embedding_v2  迁移期的第二套向量，允许为空
   *
   * 外键都带 ON DELETE CASCADE：**删文档这件事只写一行 SQL，剩下的交给数据库**。
   * 手写三条 DELETE 的版本迟早会漏掉一条，而漏掉的那条就是索引里的幽灵。
   */
  async init(dimensions: number): Promise<void> {
    await this.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector')
    await this.sql.unsafe('DROP TABLE IF EXISTS chunk_embeddings, chunks, documents CASCADE')
    await this.sql.unsafe(`
      CREATE TABLE documents (
        doc_id        text PRIMARY KEY,
        title         text NOT NULL,
        department    text NOT NULL,
        updated_at    date NOT NULL,
        content_hash  text NOT NULL,
        canonical_of  text
      )`)
    await this.sql.unsafe(`
      CREATE TABLE chunks (
        chunk_id  text PRIMARY KEY,
        doc_id    text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
        text      text NOT NULL
      )`)
    await this.sql.unsafe(`
      CREATE TABLE chunk_embeddings (
        chunk_id     text PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
        embedding    vector(${dimensions}) NOT NULL,
        embedding_v2 vector(${dimensions})
      )`)
    // 权限列上建索引：过滤谓词进了 WHERE，就要让它走得动
    await this.sql.unsafe('CREATE INDEX documents_department ON documents (department)')
  }

  async fingerprints(): Promise<Map<string, DocRow>> {
    const rows = await this.sql.unsafe(
      'SELECT doc_id, title, department, updated_at, content_hash, canonical_of FROM documents'
    )
    return new Map(
      rows.map((row) => [
        String(row.doc_id),
        {
          docId: String(row.doc_id),
          title: String(row.title),
          department: String(row.department) as Department,
          updatedAt: String(row.updated_at).slice(0, 10),
          contentHash: String(row.content_hash),
          canonicalOf: row.canonical_of === null ? null : String(row.canonical_of),
        },
      ])
    )
  }

  async upsertDoc(row: DocRow): Promise<void> {
    await this.sql.unsafe(
      `INSERT INTO documents (doc_id, title, department, updated_at, content_hash, canonical_of)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (doc_id) DO UPDATE SET title = EXCLUDED.title, department = EXCLUDED.department,
         updated_at = EXCLUDED.updated_at, content_hash = EXCLUDED.content_hash,
         canonical_of = EXCLUDED.canonical_of`,
      [row.docId, row.title, row.department, row.updatedAt, row.contentHash, row.canonicalOf]
    )
  }

  async replaceChunks(docId: string, rows: EmbeddedChunk[]): Promise<void> {
    await this.sql.unsafe('DELETE FROM chunks WHERE doc_id = $1', [docId])
    for (const { chunk, embedding } of rows) {
      await this.sql.unsafe('INSERT INTO chunks (chunk_id, doc_id, text) VALUES ($1, $2, $3)', [
        chunk.chunkId,
        chunk.docId,
        chunk.text,
      ])
      await this.sql.unsafe(
        'INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES ($1, $2::vector)',
        [chunk.chunkId, toSql(embedding)]
      )
    }
  }

  async deleteDoc(docId: string): Promise<void> {
    await this.sql.unsafe('DELETE FROM documents WHERE doc_id = $1', [docId])
  }

  /**
   * 权限过滤写进 WHERE，和排序、LIMIT 在同一条 SQL 里。
   * 数据库先按谓词裁掉行、再排序取前 k，越权的行一次都没被比较过。
   */
  async search(query: number[], opts: SearchOptions): Promise<SearchResult> {
    const column = opts.column === 'v2' ? 'COALESCE(e.embedding_v2, e.embedding)' : 'e.embedding'
    const where = opts.departments ? 'WHERE d.department = ANY($2)' : ''
    const params: unknown[] = [toSql(query)]
    if (opts.departments) params.push(opts.departments)
    const rows = await this.sql.unsafe(
      `SELECT c.chunk_id, c.doc_id, c.text, d.title, d.department,
              ${column} <=> $1::vector AS distance
         FROM chunk_embeddings e
         JOIN chunks c ON c.chunk_id = e.chunk_id
         JOIN documents d ON d.doc_id = c.doc_id
         ${where}
        ORDER BY ${column} <=> $1::vector, c.chunk_id
        LIMIT ${opts.topK}`,
      params
    )
    // 只为演示「碰了多少行、比了多少行」而多跑的一条计数，生产上不需要
    const counted = await this.sql.unsafe(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE $1::text[] IS NULL OR d.department = ANY($1))::int AS matched
         FROM chunks c JOIN documents d ON d.doc_id = c.doc_id`,
      [opts.departments ?? null]
    )
    return {
      hits: rows.map((row, i) => ({
        rank: i + 1,
        chunkId: String(row.chunk_id),
        docId: String(row.doc_id),
        title: String(row.title),
        department: String(row.department) as Department,
        text: String(row.text),
        distance: Number(Number(row.distance).toFixed(6)),
      })),
      scanned: Number(counted[0]?.matched ?? 0),
      examined: Number(counted[0]?.total ?? 0),
    }
  }

  async writeV2(rows: Array<{ chunkId: string; embedding: number[] }>): Promise<void> {
    for (const { chunkId, embedding } of rows) {
      await this.sql.unsafe(
        'UPDATE chunk_embeddings SET embedding_v2 = $2::vector WHERE chunk_id = $1',
        [chunkId, toSql(embedding)]
      )
    }
  }

  async stats(): Promise<{ docs: number; chunks: number; embeddings: number }> {
    const rows = await this.sql.unsafe(
      `SELECT (SELECT count(*) FROM documents)::int AS d,
              (SELECT count(*) FROM chunks)::int AS c,
              (SELECT count(*) FROM chunk_embeddings)::int AS e`
    )
    return {
      docs: Number(rows[0]?.d ?? 0),
      chunks: Number(rows[0]?.c ?? 0),
      embeddings: Number(rows[0]?.e ?? 0),
    }
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}

/** 唯一的存储选择点。MOCK=1 或没配 DATABASE_URL 就走内存实现，业务代码一行不改 */
export async function createIndex(isolated = false): Promise<IndexStore> {
  const url = process.env.DATABASE_URL
  if (process.env.MOCK === '1' || !url) return new MemoryIndex(isolated)
  return PgIndex.connect(url)
}
