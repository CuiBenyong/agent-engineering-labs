import type { Chunk } from './corpus'
import { embed } from './embed'

/**
 * 第九天的混合检索：关键词一路 + 向量一路，倒数排名融合，再把前 20 条交给重排。
 * 本天不改它，只是把它当尺子——所有索引结构都在这同一套检索下比。
 *
 * BM25 的公式逐项拆解在 D1，融合与重排的原理在 D9，这里只放实现。
 */

/** 中英混合分词：中文二元组、英文按词。与 D1 逐字一致，换了分词就没法跟基线比 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const segments = text.toLowerCase().match(/[一-鿿]+|[a-z0-9]+/g) ?? []
  for (const seg of segments) {
    if (/^[一-鿿]+$/.test(seg)) {
      if (seg.length === 1) {
        tokens.push(seg)
        continue
      }
      for (let i = 0; i + 1 < seg.length; i += 1) tokens.push(seg.slice(i, i + 2))
    } else if (seg.length > 1) {
      tokens.push(seg)
    }
  }
  return tokens
}

export const BM25_PARAMS = { k1: 1.2, b: 0.75 }
/** 每一路各取前 50 条（卡片 §3.7ter 定，全课统一） */
export const PER_ROUTE_TOP_K = 50
/** 融合后留前 20 条交给重排——重排贵，不能对全库跑 */
export const FUSED_TOP_K = 20
/** RRF 的常数，取自原论文的常用值，全课统一不要各天各调 */
export const RRF_K = 60

interface Bm25Index {
  postings: Map<string, Map<string, number>>
  lengths: Map<string, number>
  docCount: number
  avgLength: number
}

function buildBm25(items: { id: string; text: string }[]): Bm25Index {
  const postings = new Map<string, Map<string, number>>()
  const lengths = new Map<string, number>()
  for (const item of items) {
    const terms = tokenize(item.text)
    lengths.set(item.id, terms.length)
    for (const term of terms) {
      let byId = postings.get(term)
      if (!byId) {
        byId = new Map<string, number>()
        postings.set(term, byId)
      }
      byId.set(item.id, (byId.get(item.id) ?? 0) + 1)
    }
  }
  const total = [...lengths.values()].reduce((sum, n) => sum + n, 0)
  return {
    postings,
    lengths,
    docCount: items.length,
    avgLength: items.length ? total / items.length : 0,
  }
}

function bm25Search(index: Bm25Index, query: string, topK: number): string[] {
  const { k1, b } = BM25_PARAMS
  const terms = tokenize(query)
  const candidates = new Set<string>()
  for (const term of terms) {
    for (const id of index.postings.get(term)?.keys() ?? []) candidates.add(id)
  }
  return [...candidates]
    .map((id) => {
      const len = index.lengths.get(id) ?? 0
      const norm = 1 - b + (b * len) / (index.avgLength || 1)
      let score = 0
      for (const term of terms) {
        const f = index.postings.get(term)?.get(id) ?? 0
        if (f === 0) continue
        const n = index.postings.get(term)?.size ?? 0
        const idf = Math.log(1 + (index.docCount - n + 0.5) / (n + 0.5))
        score += (idf * (f * (k1 + 1))) / (f + k1 * norm)
      }
      return { id, score }
    })
    .sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id))
    .slice(0, topK)
    .map((h) => h.id)
}

/**
 * 倒数排名融合。只看名次不看分数：两路检索器的分数量纲不可比，归一化也不稳。
 * 规格来自课程连贯性卡片 §3.7ter，D9 定，D10–D12 逐字照抄，不要各天各写一份。
 */
export function rrfFuse(rankings: string[][], k: number = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      // 名次从 1 起算
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)) // 同分按 id 排，保证可复现
}

export type Reranker = (
  query: string,
  docs: { id: string; text: string }[]
) => Promise<{ id: string; score: number }[]>

/**
 * `MOCK=1` 下的确定性重排替身，**逐字取自 D9 的 `rerank.ts`**（卡片 §3.7ter 要求 D10–D12 直接复用）。
 * 按「查询词元与文档词元的加权重合度」打分，权重来自候选集内的文档频率：
 * 在 20 条候选里全都出现的词元没有区分度，只在一两条里出现的最值钱。
 *
 * **它不代表真实重排效果。** 真交叉编码器能读懂「组长是谁」和一个人名是一回事，
 * 这个替身只会数词。它验证的是代码路径：排序有没有真的被改写。
 */
export const mockReranker: Reranker = async (query, docs) => {
  const queryTerms = [...new Set(tokenize(query))]
  const docTerms = docs.map((d) => tokenize(d.text))
  const n = docs.length || 1

  const weight = new Map<string, number>()
  for (const term of queryTerms) {
    const df = docTerms.filter((terms) => terms.includes(term)).length
    weight.set(term, Math.log(1 + n / (df || n)))
  }
  const totalWeight = queryTerms.reduce((s, t) => s + (weight.get(t) ?? 0), 0) || 1

  return docs
    .map((doc, i) => {
      const terms = docTerms[i]
      let matchedWeight = 0
      let occurrences = 0
      for (const term of queryTerms) {
        const count = terms.filter((t) => t === term).length
        if (count === 0) continue
        matchedWeight += weight.get(term) ?? 0
        occurrences += count
      }
      const coverage = matchedWeight / totalWeight
      // 命中次数做饱和处理：多命中几次有用，但不能让长文档靠堆字数取胜
      const density = occurrences / (occurrences + 12)
      return { id: doc.id, score: Number((0.75 * coverage + 0.25 * density).toFixed(6)) }
    })
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
}

export interface Retriever {
  /** 返回融合并重排之后的块 id，按名次排列 */
  search(query: string): Promise<string[]>
  indexedTokens: number
  chunkCount: number
}

/**
 * 建一套混合检索。传进来的 `indexText` 决定「拿什么去建索引」——
 * 本天的四种索引结构差别全在这里：平铺块、子块、加了块头的块、加了块头的子块。
 * 检索逻辑一行都不变，这样对照才说得清是索引结构的功劳，不是检索器的功劳。
 */
export async function createHybridRetriever(
  chunks: Chunk[],
  indexText: (chunk: Chunk) => string,
  rerank: Reranker = mockReranker
): Promise<Retriever> {
  const items = chunks.map((c) => ({ id: c.chunkId, text: indexText(c) }))
  const bm25 = buildBm25(items)
  const byId = new Map(items.map((i) => [i.id, i.text]))
  // 一次把全部块向量化：几百个块批量一次比逐条调省钱也省时间
  const vectors = await embed(items.map((i) => i.text))

  return {
    chunkCount: chunks.length,
    indexedTokens: 0, // 由 cost.ts 填，检索器本身不关心成本
    async search(query) {
      const keywordRanking = bm25Search(bm25, query, PER_ROUTE_TOP_K)
      const [qv] = await embed([query])
      // 向量都做过 L2 归一化，所以内积就是余弦相似度
      const vectorRanking = items
        .map((item, i) => ({
          id: item.id,
          score: vectors[i].reduce((s, x, j) => s + x * qv[j], 0),
        }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
        .slice(0, PER_ROUTE_TOP_K)
        .map((h) => h.id)

      const fused = rrfFuse([keywordRanking, vectorRanking]).slice(0, FUSED_TOP_K)
      const reranked = await rerank(
        query,
        fused.map((f) => ({ id: f.id, text: byId.get(f.id) ?? '' }))
      )
      return reranked.map((r) => r.id)
    },
  }
}

/**
 * 只走关键词一路，用来单独看块头对 BM25 的影响。
 * `topK` 默认是候选池深度 20；要看「融合时这一路真正喂进去了什么」，
 * 必须传 PER_ROUTE_TOP_K（50）——两个深度不一样，对照会算错。
 */
export async function createBm25Retriever(
  chunks: Chunk[],
  indexText: (chunk: Chunk) => string,
  topK: number = FUSED_TOP_K
): Promise<Retriever> {
  const items = chunks.map((c) => ({ id: c.chunkId, text: indexText(c) }))
  const bm25 = buildBm25(items)
  return {
    chunkCount: chunks.length,
    indexedTokens: 0,
    async search(query) {
      return bm25Search(bm25, query, topK)
    },
  }
}

/** 只走向量一路，用来单独看块头对向量侧的影响。`topK` 同上 */
export async function createVectorRetriever(
  chunks: Chunk[],
  indexText: (chunk: Chunk) => string,
  topK: number = FUSED_TOP_K
): Promise<Retriever> {
  const items = chunks.map((c) => ({ id: c.chunkId, text: indexText(c) }))
  const vectors = await embed(items.map((i) => i.text))
  return {
    chunkCount: chunks.length,
    indexedTokens: 0,
    async search(query) {
      const [qv] = await embed([query])
      return items
        .map((item, i) => ({
          id: item.id,
          score: vectors[i].reduce((s, x, j) => s + x * qv[j], 0),
        }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
        .slice(0, topK)
        .map((h) => h.id)
    },
  }
}
