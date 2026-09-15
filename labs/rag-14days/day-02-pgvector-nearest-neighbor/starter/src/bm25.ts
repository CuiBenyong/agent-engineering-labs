import { tokenize } from './tokenize'

export interface BM25Params {
  /** 词频饱和系数：越小，重复出现同一个词带来的收益越快到顶 */
  k1: number
  /** 长度归一化强度：0 完全不看文档长度，1 完全按长度惩罚 */
  b: number
}

export const DEFAULT_PARAMS: BM25Params = { k1: 1.2, b: 0.75 }

export interface BM25Index {
  /** 倒排表：词元 -> (文档 id -> 该词在这篇里出现了几次) */
  postings: Map<string, Map<string, number>>
  /** 每篇文档的词元总数 */
  lengths: Map<string, number>
  docCount: number
  avgLength: number
}

export interface Hit {
  rank: number
  docId: string
  score: number
}

export function buildIndex(docs: { id: string; text: string }[]): BM25Index {
  const postings = new Map<string, Map<string, number>>()
  const lengths = new Map<string, number>()

  for (const doc of docs) {
    const terms = tokenize(doc.text)
    lengths.set(doc.id, terms.length)
    for (const term of terms) {
      let byDoc = postings.get(term)
      if (!byDoc) {
        byDoc = new Map<string, number>()
        postings.set(term, byDoc)
      }
      byDoc.set(doc.id, (byDoc.get(doc.id) ?? 0) + 1)
    }
  }

  const total = [...lengths.values()].reduce((sum, n) => sum + n, 0)
  return { postings, lengths, docCount: docs.length, avgLength: total / docs.length }
}

/**
 * 逆文档频率。用的是 BM25 的平滑版本：
 *
 *   idf(t) = ln(1 + (N - n(t) + 0.5) / (n(t) + 0.5))
 *
 * 直觉：一个词出现在越少的文档里，它越能把文档区分开，权重就越高。
 * 「的」「我们」这种到处都是的词，n(t) 接近 N，算出来接近 0，等于自动被降权——
 * 这就是为什么 BM25 不需要一份停用词表也能用。
 * 外面套的 ln(1 + …) 是为了避免 n(t) 大于 N/2 时算出负数。
 */
export function idf(index: BM25Index, term: string): number {
  const n = index.postings.get(term)?.size ?? 0
  return Math.log(1 + (index.docCount - n + 0.5) / (n + 0.5))
}

/**
 * 单篇文档对一组查询词元的 BM25 得分：
 *
 *   score = Σ idf(t) · ( f(t,D)·(k1+1) ) / ( f(t,D) + k1·(1 - b + b·|D|/avgdl) )
 *
 * 两个修正各管一件事：
 * - k1 管**词频饱和**。分子分母同时含 f，f 涨到很大时整个分式趋近 k1+1，不会无限增长。
 *   一篇文章把「回收站」写 50 遍，不该比写 5 遍的相关 10 倍。
 * - b 管**文档长度归一化**。长文档天然更容易蒙中关键词，用 |D|/avgdl 把它按超出平均的比例压回去。
 *   b=0 时完全不归一化，b=1 时完全按长度比例惩罚，0.75 是长期实践下来的折中。
 */
export function scoreDoc(
  index: BM25Index,
  docId: string,
  queryTerms: string[],
  params: BM25Params = DEFAULT_PARAMS
): number {
  const len = index.lengths.get(docId) ?? 0
  const norm = 1 - params.b + (params.b * len) / index.avgLength
  let score = 0
  for (const term of queryTerms) {
    const f = index.postings.get(term)?.get(docId) ?? 0
    if (f === 0) continue
    score += (idf(index, term) * (f * (params.k1 + 1))) / (f + params.k1 * norm)
  }
  return score
}

export function search(
  index: BM25Index,
  query: string,
  topK: number,
  params: BM25Params = DEFAULT_PARAMS
): Hit[] {
  const queryTerms = tokenize(query)
  // 只对「至少命中一个查询词」的候选打分：倒排索引存在的意义就是不必扫全库
  const candidates = new Set<string>()
  for (const term of queryTerms) {
    for (const docId of index.postings.get(term)?.keys() ?? []) candidates.add(docId)
  }

  return (
    [...candidates]
      .map((docId) => ({ docId, score: scoreDoc(index, docId, queryTerms, params) }))
      // 同分时按 docId 定序，否则不同运行环境的遍历顺序会让 baseline.json 对不上
      .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
      .slice(0, topK)
      .map((hit, i) => ({ rank: i + 1, docId: hit.docId, score: Number(hit.score.toFixed(4)) }))
  )
}
