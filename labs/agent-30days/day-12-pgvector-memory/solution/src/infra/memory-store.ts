import type { MemoryRow, Store } from './store'

/**
 * 余弦相似度：点积除以两个模长。写入端已经归一化过，直接点积也对，
 * 但这里不做这个假设——除模长能挡住「长文本天然得分高」这种静默错误。
 */
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

// 内存实现：全表扫描 + 余弦相似度排序。真实实现走 HNSW 索引（见 pg-store.ts），这里为了
// 看清楚用全表扫描——语义一致，差别在几十万条时的耗时，以及 HNSW 是「近似」最近邻。
export function createMemoryStore(): Store {
  const rows: MemoryRow[] = []
  return {
    async init() {
      // 内存实现没有 schema 要建
    },
    async insert(newRows) {
      rows.push(...newRows)
    },
    async search(userId, embedding, limit) {
      return rows
        .filter((row) => row.userId === userId)
        .map((row) => ({
          id: row.id,
          content: row.content,
          createdAt: row.createdAt,
          score: cosineSimilarity(embedding, row.embedding),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
    async close() {
      rows.length = 0
    },
  }
}
