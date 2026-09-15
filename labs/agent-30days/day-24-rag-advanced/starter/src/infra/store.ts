import type { Chunk } from '../corpus'
import { createPgStore } from './pg-store'

/** 一条打了分的命中。score 的量纲两路不一样，所以融合时只用名次不用它——见 rrfFuse。 */
export interface Scored {
  chunkId: string
  score: number
}

/** 落库的一块：正文 + 向量 + 关键词那一路用的词项。 */
export interface StoredChunk extends Chunk {
  embedding: number[]
  terms: string[]
}

/**
 * 知识库的端口。业务代码只认这个接口，所以内存版和 pgvector 版跑的是同一份检索逻辑。
 * 注意这里有**两个**检索方法：本天的全部内容就是「怎么把这两路的结果合到一起」。
 */
export interface Store {
  init(): Promise<void>
  upsert(chunks: StoredChunk[]): Promise<void>
  /** 向量那一路：余弦相似度 top-N。 */
  vectorSearch(embedding: number[], limit: number): Promise<Scored[]>
  /** 关键词那一路：BM25 / ts_rank top-N。terms 由调用方用 bigrams() 切好。 */
  keywordSearch(terms: string[], limit: number): Promise<Scored[]>
  /** 按 chunkId 取回正文，保持传入的顺序。 */
  resolve(chunkIds: string[]): Chunk[]
  size(): number
  close(): Promise<void>
}

/** 唯一的选择点：有 DATABASE_URL 就走真的 pgvector，否则走内存实现。 */
export function createStore(): Store {
  const url = process.env.DATABASE_URL
  return url ? createPgStore(url) : createMemoryStore()
}

export function storeKind(): string {
  return process.env.DATABASE_URL ? 'pgvector + tsvector（真实 Postgres）' : '内存实现（全表扫描）'
}

// ---------------------------------------------------------------------------
// 内存实现：不是打桩，是把两路检索的语义各写了一遍。
// ---------------------------------------------------------------------------

/** 余弦相似度：点积除以两个模长（来自 D12，一行没改）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// BM25 的两个常数，用的是几乎所有实现的默认值。
const BM25_K1 = 1.2
const BM25_B = 0.75

export function createMemoryStore(): Store {
  const rows: StoredChunk[] = []
  const byId = new Map<string, StoredChunk>()
  // 文档频次：一个词出现在多少块里。越少见的词命中时越有信息量，这就是 idf。
  const df = new Map<string, number>()
  let avgLen = 0

  return {
    async init() {
      // 内存实现没有 schema 要建
    },
    async upsert(chunks) {
      for (const chunk of chunks) {
        if (byId.has(chunk.chunkId)) continue
        byId.set(chunk.chunkId, chunk)
        rows.push(chunk)
        for (const term of new Set(chunk.terms)) df.set(term, (df.get(term) ?? 0) + 1)
      }
      avgLen = rows.reduce((sum, row) => sum + row.terms.length, 0) / Math.max(rows.length, 1)
    },
    async vectorSearch(embedding, limit) {
      // 全表扫描 + 排序。真实实现走 HNSW 近似最近邻，语义一致但**可能漏**，见 D12。
      return rows
        .map((row) => ({ chunkId: row.chunkId, score: cosineSimilarity(embedding, row.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
    async keywordSearch(terms, limit) {
      // BM25：Σ idf(t) × 饱和后的词频。这里 tf 只取 0/1（出现过就算），
      // 因为 bigram 切出来的词重复出现并不代表更相关。长度归一化留着——
      // 没有它，长文档天然比一条 FAQ 更容易得分。
      const query = new Set(terms)
      const scored: Scored[] = []
      for (const row of rows) {
        const own = new Set(row.terms)
        let score = 0
        for (const term of query) {
          if (!own.has(term)) continue
          const idf = Math.log(
            1 + (rows.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5)
          )
          const norm = 1 - BM25_B + (BM25_B * row.terms.length) / avgLen
          score += idf * ((BM25_K1 + 1) / (1 + BM25_K1 * norm))
        }
        if (score > 0) scored.push({ chunkId: row.chunkId, score })
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, limit)
    },
    resolve(chunkIds) {
      return chunkIds
        .map((id) => byId.get(id))
        .filter((chunk): chunk is StoredChunk => chunk !== undefined)
    },
    size() {
      return rows.length
    },
    async close() {
      rows.length = 0
      byId.clear()
      df.clear()
    },
  }
}
