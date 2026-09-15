import type { MemoryRow, Store } from './store'

/**
 * 练习 2：实现余弦相似度——点积除以两个向量的模长。
 * 提示：写入端已经归一化过，光算点积也能得到正确排序，但别省掉除模长这一步；
 *   换一个不归一化的 embedding 实现时，它能挡住「长文本天然得分高」这种静默错误。
 * 现在恒返回 0：跑自检你会看到两个完全不同的 query 命中同一条记忆——
 * 因为相似度根本没参与排序，排出来的只是插入顺序。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  void a
  void b
  return 0
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
