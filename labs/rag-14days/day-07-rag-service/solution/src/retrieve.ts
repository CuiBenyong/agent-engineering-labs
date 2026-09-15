import type { RagConfig } from './config'
import type { EmbeddingBackend } from './embed'
import type { Store, StoredChunk } from './store'

/**
 * 查询链路。它跟摄取链路的唯一交集是 Store——摄取写进去什么，这里就读到什么。
 *
 * 两路检索并列跑：关键词一路是 D1 那个 BM25，向量一路走 Store。
 * 融合方式**故意做得很朴素**（每一路按自己的最高分归一化，再加权相加），
 * 因为现在还没有评估，任何更花哨的融合都只是拍脑袋。D8 建好评估、D9 换成
 * 倒数排名融合再加重排——到那时才有资格说哪种更好。
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

interface Bm25Index {
  postings: Map<string, Map<string, number>>
  lengths: Map<string, number>
  docCount: number
  avgLength: number
}

/**
 * BM25 索引建在内存里，服务启动和每次摄取之后重建一次。
 *
 * 30 篇语料这么做完全够用，但要清楚它的边界：文档一多，重建就会变成秒级甚至分钟级，
 * 而且多个服务实例各建一份还会不一致。生产上关键词这一路应该落到
 * PostgreSQL 的全文检索或者独立的检索引擎里。这是这一版明确留下的一笔债。
 */
export function buildBm25(chunks: StoredChunk[]): Bm25Index {
  const postings = new Map<string, Map<string, number>>()
  const lengths = new Map<string, number>()
  for (const chunk of chunks) {
    const terms = tokenize(`${chunk.headingPath.join(' ')} ${chunk.text}`)
    lengths.set(chunk.chunkId, terms.length)
    for (const term of terms) {
      let byChunk = postings.get(term)
      if (!byChunk) {
        byChunk = new Map<string, number>()
        postings.set(term, byChunk)
      }
      byChunk.set(chunk.chunkId, (byChunk.get(chunk.chunkId) ?? 0) + 1)
    }
  }
  const total = [...lengths.values()].reduce((sum, n) => sum + n, 0)
  return {
    postings,
    lengths,
    docCount: chunks.length,
    avgLength: chunks.length ? total / chunks.length : 0,
  }
}

/** 公式与两个修正项各自在防什么，见 D1；这里只是把它搬到块粒度上 */
function bm25Search(
  index: Bm25Index,
  query: string,
  topK: number,
  params: { k1: number; b: number }
): { chunkId: string; score: number }[] {
  const terms = tokenize(query)
  const candidates = new Set<string>()
  for (const term of terms) {
    for (const id of index.postings.get(term)?.keys() ?? []) candidates.add(id)
  }
  return [...candidates]
    .map((chunkId) => {
      const len = index.lengths.get(chunkId) ?? 0
      const norm = 1 - params.b + (params.b * len) / (index.avgLength || 1)
      let score = 0
      for (const term of terms) {
        const f = index.postings.get(term)?.get(chunkId) ?? 0
        if (f === 0) continue
        const n = index.postings.get(term)?.size ?? 0
        const idf = Math.log(1 + (index.docCount - n + 0.5) / (n + 0.5))
        score += (idf * (f * (params.k1 + 1))) / (f + params.k1 * norm)
      }
      return { chunkId, score }
    })
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, topK)
}

export interface Candidate {
  chunk: StoredChunk
  /** 每一路的原始分。没跑那一路就是 undefined，不要拿 0 冒充 */
  bm25?: number
  vector?: number
  /** 归一化加权之后的融合分，只用来排序，不要拿它当置信度 */
  fused: number
  /** 至少有一路认为这条「够得着」 */
  admitted: boolean
  routes: string[]
}

export interface RetrievalResult {
  candidates: Candidate[]
  used: Candidate[]
  routes: string[]
}

export class Retriever {
  private index: Bm25Index = buildBm25([])
  private byId = new Map<string, StoredChunk>()

  constructor(
    private store: Store,
    private cfg: RagConfig,
    private embedder: EmbeddingBackend
  ) {}

  /** 每次摄取之后必须调一次，否则新入库的块检索不到 */
  async refresh(): Promise<number> {
    const chunks = await this.store.listChunks()
    this.byId = new Map(chunks.map((c) => [c.chunkId, c]))
    this.index = buildBm25(chunks)
    return chunks.length
  }

  async retrieve(question: string): Promise<RetrievalResult> {
    const { routes, perRouteTopK, topK, weights, gates, bm25 } = this.cfg.retrieval
    const raw = new Map<string, { bm25?: number; vector?: number }>()

    if (routes.includes('bm25')) {
      for (const hit of bm25Search(this.index, question, perRouteTopK, bm25)) {
        raw.set(hit.chunkId, { ...raw.get(hit.chunkId), bm25: hit.score })
      }
    }
    if (routes.includes('vector')) {
      const [vector] = await this.embedder.embed([question])
      for (const hit of await this.store.vectorSearch(vector, perRouteTopK)) {
        raw.set(hit.chunkId, { ...raw.get(hit.chunkId), vector: hit.score })
      }
    }

    // 两路分数的量纲完全不同（BM25 是无上界的加和，余弦在 -1 到 1 之间），
    // 直接相加毫无意义。这里各自除以本路最高分压到 0–1 再加权——
    // 能用，但它对「本路最高分本身很低」的情况是瞎的，这正是 D9 换掉它的原因。
    const maxBm25 = Math.max(...[...raw.values()].map((r) => r.bm25 ?? 0), 1e-9)
    const maxVector = Math.max(...[...raw.values()].map((r) => r.vector ?? 0), 1e-9)

    const candidates: Candidate[] = [...raw.entries()]
      .map(([chunkId, scores]) => {
        const chunk = this.byId.get(chunkId)
        if (!chunk) throw new Error(`索引里有一个库里没有的块：${chunkId}`)
        const hitRoutes: string[] = []
        if (scores.bm25 !== undefined) hitRoutes.push('bm25')
        if (scores.vector !== undefined) hitRoutes.push('vector')
        const fused =
          ((scores.bm25 ?? 0) / maxBm25) * weights.bm25 +
          ((scores.vector ?? 0) / maxVector) * weights.vector
        // 门槛卡在**原始分**上而不是融合分上：融合分是相对的，最不相干的那批也能拿到 1.0
        const admitted =
          (scores.bm25 ?? 0) >= gates.bm25MinScore || (scores.vector ?? 0) >= gates.vectorMinCosine
        return { chunk, ...scores, fused, admitted, routes: hitRoutes }
      })
      .sort((a, b) => b.fused - a.fused || a.chunk.chunkId.localeCompare(b.chunk.chunkId))
      .slice(0, perRouteTopK * 2)

    return { candidates, used: candidates.filter((c) => c.admitted).slice(0, topK), routes }
  }
}
