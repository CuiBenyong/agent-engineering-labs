import type { Chunk } from './corpus'
import { createEmbedBackend } from './embed'

/**
 * 第一周那套检索（D1 的 BM25 + D2 的向量 + D7 的朴素加权融合），逐字复制自 D8，本天不改。
 *
 * 这一天动的是**查询进来之后、检索发生之前**那一段。检索器本身保持 D8 的样子，
 * 才能保证今天跑出来的指标和 D8 的基线可比——换了检索器再谈「改写涨了多少」是自欺欺人。
 *
 * 唯一的新增是文件末尾的 `rrfFuse`：多路查询要把几个检索式各自的名次合起来。
 */

export const WEEK1_RETRIEVAL = {
  perRouteTopK: 8,
  weights: { bm25: 1, vector: 0.6 },
  gates: { bm25MinScore: 6, vectorMinCosine: 0.2 },
  bm25: { k1: 1.2, b: 0.75 },
}

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

function buildBm25(chunks: Chunk[]): Bm25Index {
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

interface Scored {
  chunkId: string
  score: number
}

/** 公式与两个修正项各自在防什么见 D1；同分时按 chunkId 定序，保证跑几次都一样 */
function bm25Search(index: Bm25Index, query: string, topK: number): Scored[] {
  const { k1, b } = WEEK1_RETRIEVAL.bm25
  const terms = tokenize(query)
  const candidates = new Set<string>()
  for (const term of terms) {
    for (const id of index.postings.get(term)?.keys() ?? []) candidates.add(id)
  }
  return [...candidates]
    .map((chunkId) => {
      const len = index.lengths.get(chunkId) ?? 0
      const norm = 1 - b + (b * len) / (index.avgLength || 1)
      let score = 0
      for (const term of terms) {
        const f = index.postings.get(term)?.get(chunkId) ?? 0
        if (f === 0) continue
        const n = index.postings.get(term)?.size ?? 0
        const idf = Math.log(1 + (index.docCount - n + 0.5) / (n + 0.5))
        score += (idf * (f * (k1 + 1))) / (f + k1 * norm)
      }
      return { chunkId, score }
    })
    .sort((a, b2) => b2.score - a.score || a.chunkId.localeCompare(b2.chunkId))
    .slice(0, topK)
}

export interface Candidate {
  chunk: Chunk
  /** 每一路的原始分。没进那一路就是 undefined，不要拿 0 冒充 */
  bm25?: number
  vector?: number
  fused: number
  /** 至少有一路认为这条「够得着」。检索侧拒答看的就是它 */
  admitted: boolean
}

export interface Retriever {
  /** 一次检索 = 一个检索式跑一遍 BM25 与向量两路并加权融合。计成本时它是一个单位 */
  retrieve(query: string): Promise<Candidate[]>
  chunkCount: number
  backendName: string
}

export async function createWeek1Retriever(chunks: Chunk[]): Promise<Retriever> {
  const backend = createEmbedBackend()
  const index = buildBm25(chunks)
  const byId = new Map(chunks.map((c) => [c.chunkId, c]))
  const vectors = await backend.embed(chunks.map((c) => `${c.headingPath.join(' ')}\n${c.text}`))

  return {
    chunkCount: chunks.length,
    backendName: backend.name,
    async retrieve(query) {
      const { perRouteTopK, weights, gates } = WEEK1_RETRIEVAL
      const raw = new Map<string, { bm25?: number; vector?: number }>()
      for (const hit of bm25Search(index, query, perRouteTopK)) {
        raw.set(hit.chunkId, { ...raw.get(hit.chunkId), bm25: hit.score })
      }
      const [qv] = await backend.embed([query])
      const cos = chunks
        .map((c, i) => ({
          chunkId: c.chunkId,
          score: vectors[i].reduce((s, x, j) => s + x * qv[j], 0),
        }))
        .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
        .slice(0, perRouteTopK)
      for (const hit of cos) raw.set(hit.chunkId, { ...raw.get(hit.chunkId), vector: hit.score })

      const maxBm25 = Math.max(...[...raw.values()].map((r) => r.bm25 ?? 0), 1e-9)
      const maxVector = Math.max(...[...raw.values()].map((r) => r.vector ?? 0), 1e-9)

      return [...raw.entries()]
        .map(([chunkId, scores]) => {
          const chunk = byId.get(chunkId)
          if (!chunk) throw new Error(`索引里有一个语料里没有的块：${chunkId}`)
          const fused =
            ((scores.bm25 ?? 0) / maxBm25) * weights.bm25 +
            ((scores.vector ?? 0) / maxVector) * weights.vector
          const admitted =
            (scores.bm25 ?? 0) >= gates.bm25MinScore ||
            (scores.vector ?? 0) >= gates.vectorMinCosine
          return { chunk, ...scores, fused, admitted }
        })
        .sort((a, b) => b.fused - a.fused || a.chunk.chunkId.localeCompare(b.chunk.chunkId))
    },
  }
}

// ---------------------------------------------------------------------------
// 倒数排名融合（沿用 D9 的规格，本天不重讲原理）
// ---------------------------------------------------------------------------

/** k = 60 是原论文的常用取值，全课统一，不要各天各调一个 */
export const RRF_K = 60

/**
 * 倒数排名融合：只看名次不看分数。
 *
 * D9 拿它融合「BM25 一路」与「向量一路」；今天融合的是**同一个检索器、不同检索式**跑出来的
 * 几份名次。融合的轴变了，函数一个字都不用改——这正是它比按分数加权稳的地方：
 * 分数量纲不可比时它照样能用，因为它压根不看分数。
 */
export function rrfFuse(
  rankings: string[][],
  k: number = RRF_K
): Array<{ id: string; score: number }> {
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

/**
 * 把几份检索结果按名次融合成一份。
 *
 * 门槛（admitted）不能跟着融合分走——融合分是相对的，最不相干的那一批也能拿到最高分。
 * 所以这里保留**每一路给出的原始最高分**，让拒答判定仍然踩在绝对分上。
 * 这一条是 `none` 类问题不被 HyDE 带偏的最后一道闸，改之前先看正文那一段。
 */
export function fuseCandidates(results: Candidate[][]): Candidate[] {
  const byId = new Map<string, Candidate>()
  for (const list of results) {
    for (const c of list) {
      const prev = byId.get(c.chunk.chunkId)
      if (!prev) {
        byId.set(c.chunk.chunkId, { ...c })
        continue
      }
      prev.bm25 = Math.max(prev.bm25 ?? 0, c.bm25 ?? 0) || undefined
      prev.vector = Math.max(prev.vector ?? 0, c.vector ?? 0) || undefined
      prev.admitted = prev.admitted || c.admitted
    }
  }
  const fused = rrfFuse(results.map((list) => list.map((c) => c.chunk.chunkId)))
  return fused.map(({ id, score }) => {
    const c = byId.get(id)
    if (!c) throw new Error(`融合结果里出现了未知的块：${id}`)
    return { ...c, fused: score }
  })
}
