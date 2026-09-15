import { toSql } from 'pgvector'

/**
 * 向量库的端口（接口）与两个实现：
 *
 *   PgStore     —— 真实的 PostgreSQL + pgvector，本天的主角
 *   MemoryStore —— 内存数组 + 全表扫描，MOCK=1 或没配 DATABASE_URL 时用
 *
 * 两个实现的**语义**必须一样：同一批向量、同一个查询，排出来的名次必须一致。
 * 内存版只是不要性能（全表线性扫），真实版才有索引。业务代码只认这个接口。
 */

export interface VectorRow {
  chunkId: string
  docId: string
  title: string
  department: string
  updatedAt: string
  text: string
  embedding: number[]
}

export interface NeighborHit {
  rank: number
  chunkId: string
  docId: string
  title: string
  department: string
  /** 余弦距离，0 表示方向完全一致；相似度 = 1 - 距离 */
  distance: number
}

export interface SearchOptions {
  topK: number
  /** true 时查半精度列（pgvector 的 halfvec），用来对比精度损失 */
  half?: boolean
}

export interface StorageSize {
  /** 全精度向量列占用的字节数 */
  fullBytes: number
  /** 半精度向量列占用的字节数 */
  halfBytes: number
  /** 真实值来自数据库统计，估算值来自 每维字节数 × 维数 × 行数 */
  measured: boolean
}

export interface VectorStore {
  readonly kind: string
  init(dimensions: number): Promise<void>
  upsert(rows: VectorRow[]): Promise<void>
  createIndex(): Promise<string>
  search(query: number[], opts: SearchOptions): Promise<NeighborHit[]>
  storageSize(): Promise<StorageSize>
  /** 返回查询计划的关键几行；内存版没有计划可看，返回 null */
  explain(query: number[], topK: number): Promise<string[] | null>
  close(): Promise<void>
}

/**
 * 把一个 32 位浮点数量化到半精度（16 位浮点）能表示的最近值：
 * 半精度只有 10 位尾数，所以按 2 的幂对齐后保留 10 位小数位再还原。
 * 这是 pgvector 的 halfvec 在做的事的一个近似——用来在离线模式下也能看到「精度掉了一点」的现象。
 */
export function toHalf(x: number): number {
  // 练习 4：把 x 量化到半精度能表示的最近值。
  //   取 exponent = Math.floor(Math.log2(Math.abs(x)))，scale = 2 ** (10 - exponent)，
  //   然后 Math.round(x * scale) / scale；x 为 0 或非有限值时原样返回。
  // 提示：不做这一步，程序会告诉你「半精度和全精度的距离偏差是 0」——
  //       那不是「半精度没有损失」，是你根本没有降精度。
  return x
}

/**
 * 余弦距离 = 1 - 余弦相似度。
 * 传进来的向量都已经 L2 归一化（见 embed.ts），所以余弦相似度就是内积，
 * 这里一个除法都不用做——归一化的好处在这一行看得最清楚。
 */
export function cosineDistance(a: number[], b: number[]): number {
  // 练习 3：算两个向量的余弦距离。
  //   两个向量都已经归一化（练习 2 做完之后），所以余弦相似度就是内积：逐维相乘再求和。
  //   距离 = 1 - 相似度。
  // 提示：现在恒等于 0，所有文档「一样近」，名次退化成按 chunkId 排序——
  //       这正是 pgvector 里 `<=>` 帮你做的那件事，先自己写一遍再去用它。
  void a
  void b
  return 0
}

export class MemoryStore implements VectorStore {
  readonly kind = 'memory（内存数组 + 全表扫描）'
  private rows: VectorRow[] = []
  private dimensions = 0

  async init(dimensions: number): Promise<void> {
    this.dimensions = dimensions
    this.rows = []
  }

  async upsert(rows: VectorRow[]): Promise<void> {
    this.rows = [...rows]
  }

  async createIndex(): Promise<string> {
    return '内存版没有索引：30 行全表扫描本来就够快，真实实现走 HNSW，见 D5'
  }

  async search(query: number[], opts: SearchOptions): Promise<NeighborHit[]> {
    const scored = this.rows.map((row) => {
      const vec = opts.half ? row.embedding.map(toHalf) : row.embedding
      return { row, distance: cosineDistance(query, vec) }
    })
    return (
      scored
        // 同距离时按 chunkId 定序：不给决胜键的话，换个运行环境名次就可能不一样
        .sort((a, b) => a.distance - b.distance || a.row.chunkId.localeCompare(b.row.chunkId))
        .slice(0, opts.topK)
        .map((item, i) => ({
          rank: i + 1,
          chunkId: item.row.chunkId,
          docId: item.row.docId,
          title: item.row.title,
          department: item.row.department,
          distance: Number(item.distance.toFixed(6)),
        }))
    )
  }

  async storageSize(): Promise<StorageSize> {
    // vector 每维 4 字节，halfvec 每维 2 字节，各再加 8 字节表头
    const rows = this.rows.length
    return {
      fullBytes: rows * (this.dimensions * 4 + 8),
      halfBytes: rows * (this.dimensions * 2 + 8),
      measured: false,
    }
  }

  async explain(): Promise<string[] | null> {
    return null
  }

  async close(): Promise<void> {}
}

type Sql = {
  unsafe: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
  end: () => Promise<void>
}

export class PgStore implements VectorStore {
  readonly kind = 'pgvector（PostgreSQL 16 + vector 扩展）'
  private dimensions = 0

  private constructor(private readonly sql: Sql) {}

  static async connect(url: string): Promise<PgStore> {
    const { default: postgres } = await import('postgres')
    return new PgStore(postgres(url) as unknown as Sql)
  }

  /**
   * 表结构按课程统一口径：documents / chunks / chunk_embeddings。
   * 今天一篇文档只切一块（chunkId 形如 doc-003#c01），真正的切块是 D4 的事，
   * 但表先按最终形态建好，后面几天只往里加列和索引，不改表名。
   */
  async init(dimensions: number): Promise<void> {
    this.dimensions = dimensions
    await this.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector')
    await this.sql.unsafe('DROP TABLE IF EXISTS chunk_embeddings, chunks, documents CASCADE')
    await this.sql.unsafe(`
      CREATE TABLE documents (
        doc_id      text PRIMARY KEY,
        title       text NOT NULL,
        department  text NOT NULL,
        updated_at  date NOT NULL
      )`)
    await this.sql.unsafe(`
      CREATE TABLE chunks (
        chunk_id  text PRIMARY KEY,
        doc_id    text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
        text      text NOT NULL
      )`)
    // 同一份向量存两列：全精度与半精度，方便直接对比占用和名次差异
    await this.sql.unsafe(`
      CREATE TABLE chunk_embeddings (
        chunk_id   text PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
        embedding  vector(${dimensions}) NOT NULL,
        embedding_half halfvec(${dimensions}) NOT NULL
      )`)
  }

  async upsert(rows: VectorRow[]): Promise<void> {
    for (const row of rows) {
      await this.sql.unsafe(
        `INSERT INTO documents (doc_id, title, department, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (doc_id) DO UPDATE SET title = EXCLUDED.title`,
        [row.docId, row.title, row.department, row.updatedAt]
      )
      await this.sql.unsafe(
        `INSERT INTO chunks (chunk_id, doc_id, text) VALUES ($1, $2, $3)
         ON CONFLICT (chunk_id) DO UPDATE SET text = EXCLUDED.text`,
        [row.chunkId, row.docId, row.text]
      )
      // toSql 把 number[] 变成 pgvector 认识的 "[0.1,0.2,…]" 文本，再由 ::vector 转成向量类型
      await this.sql.unsafe(
        `INSERT INTO chunk_embeddings (chunk_id, embedding, embedding_half)
         VALUES ($1, $2::vector, $2::vector::halfvec)
         ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [row.chunkId, toSql(row.embedding)]
      )
    }
  }

  /**
   * HNSW 索引。今天只到「建了个索引、能查」，参数怎么调、召回率掉多少是 D5 的内容。
   * 注意运算符类：余弦距离要用 vector_cosine_ops，跟查询里的 <=> 必须配套，
   * 配错了索引就是白建的——规划器不会用它。
   */
  async createIndex(): Promise<string> {
    await this.sql.unsafe(
      'CREATE INDEX IF NOT EXISTS chunk_embeddings_hnsw ON chunk_embeddings USING hnsw (embedding vector_cosine_ops)'
    )
    return 'CREATE INDEX … USING hnsw (embedding vector_cosine_ops)'
  }

  async search(query: number[], opts: SearchOptions): Promise<NeighborHit[]> {
    const column = opts.half ? 'e.embedding_half' : 'e.embedding'
    const cast = opts.half ? '::vector::halfvec' : '::vector'
    const rows = await this.sql.unsafe(
      `SELECT c.chunk_id, c.doc_id, d.title, d.department,
              ${column} <=> $1${cast} AS distance
         FROM chunk_embeddings e
         JOIN chunks c ON c.chunk_id = e.chunk_id
         JOIN documents d ON d.doc_id = c.doc_id
        ORDER BY ${column} <=> $1${cast}, c.chunk_id
        LIMIT ${opts.topK}`,
      [toSql(query)]
    )
    return rows.map((row, i) => ({
      rank: i + 1,
      chunkId: String(row.chunk_id),
      docId: String(row.doc_id),
      title: String(row.title),
      department: String(row.department),
      distance: Number(Number(row.distance).toFixed(6)),
    }))
  }

  async storageSize(): Promise<StorageSize> {
    const rows = await this.sql.unsafe(
      `SELECT sum(pg_column_size(embedding))::bigint AS full_bytes,
              sum(pg_column_size(embedding_half))::bigint AS half_bytes
         FROM chunk_embeddings`
    )
    return {
      fullBytes: Number(rows[0]?.full_bytes ?? 0),
      halfBytes: Number(rows[0]?.half_bytes ?? 0),
      measured: true,
    }
  }

  /**
   * 看查询计划里到底走没走索引。只有 30 行时规划器多半会认为全表扫描更快，
   * 这不是索引坏了——把 enable_seqscan 关掉再看一遍，就能看到 Index Scan using chunk_embeddings_hnsw。
   */
  async explain(query: number[], topK: number): Promise<string[] | null> {
    const run = async (): Promise<string[]> => {
      const rows = await this.sql.unsafe(
        `EXPLAIN (COSTS OFF)
         SELECT chunk_id FROM chunk_embeddings ORDER BY embedding <=> $1::vector LIMIT ${topK}`,
        [toSql(query)]
      )
      // 计划里会把整条查询向量原样打出来，几百个数字刷屏，折叠掉只留结构
      return rows.map((row) =>
        String(row['QUERY PLAN']).replace(/'\[[^\]]*\]'::vector/g, "'[查询向量]'::vector")
      )
    }
    const plain = await run()
    await this.sql.unsafe('SET enable_seqscan = off')
    const forced = await run()
    await this.sql.unsafe('SET enable_seqscan = on')
    return [
      ...plain.map((line) => `  默认        ${line}`),
      ...forced.map((line) => `  关掉全表扫描 ${line}`),
    ]
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}

/** 唯一的向量库选择点：MOCK=1 或没配 DATABASE_URL 就走内存版，业务代码不变 */
export async function createStore(): Promise<VectorStore> {
  const url = process.env.DATABASE_URL
  if (process.env.MOCK === '1' || !url) return new MemoryStore()
  return PgStore.connect(url)
}
