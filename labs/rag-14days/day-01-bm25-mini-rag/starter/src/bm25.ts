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
 * 逆文档频率：一个词出现在越少的文档里，它越能把文档区分开，权重就越高。
 */
export function idf(index: BM25Index, term: string): number {
  // 练习 2：实现 BM25 的平滑逆文档频率。
  //   idf(t) = ln(1 + (N - n(t) + 0.5) / (n(t) + 0.5))
  //   N 是 index.docCount，n(t) 是 index.postings.get(term)?.size ?? 0
  // 提示：外面那层 ln(1 + …) 不是装饰，去掉它在 n(t) 大于 N/2 时会算出负分。
  //       下面这行返回常数 1，等于「所有词一样重要」——做完练习 1 之后先跑一次，
  //       你会看到「的」「我们」这类到处都是的词把排序带偏。
  void index
  void term
  return 1
}

/**
 * 单篇文档对一组查询词元的 BM25 得分。
 */
export function scoreDoc(
  index: BM25Index,
  docId: string,
  queryTerms: string[],
  params: BM25Params = DEFAULT_PARAMS
): number {
  // 练习 3：把下面的朴素 tf-idf 换成完整的 BM25 打分：
  //   score = Σ idf(t) · ( f(t,D)·(k1+1) ) / ( f(t,D) + k1·(1 - b + b·|D|/avgdl) )
  //   |D| 是 index.lengths.get(docId)，avgdl 是 index.avgLength。
  // 提示：先把 1 - b + b·|D|/avgdl 这一项单独算出来存成 norm，循环里就只剩一行。
  //       现在这版没有词频饱和、也没有长度归一化：一篇长文把关键词写 50 遍就能霸榜，
  //       改完之后把 K1 和 B 调几次，对比同一个问题的前三名怎么变。
  void params
  let score = 0
  for (const term of queryTerms) {
    const f = index.postings.get(term)?.get(docId) ?? 0
    if (f === 0) continue
    score += idf(index, term) * f
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
