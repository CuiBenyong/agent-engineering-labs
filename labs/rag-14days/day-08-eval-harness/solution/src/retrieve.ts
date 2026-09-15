import type { Chunk } from './corpus'
import { createEmbedBackend } from './embed'

/**
 * 第一周那套检索（D1 的 BM25 + D2 的向量 + D7 的朴素融合），本天不改。
 *
 * 参数逐字取自 D7 的 `rag.config.json`：两路各取 8 条、加权 1 : 0.6、门槛
 * bm25 ≥ 6 或 cosine ≥ 0.2。**这一天的任务是给这套系统称重，不是改它。**
 * 想改的冲动请留到 D9——到那时你手里有秤了。
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

interface Scored {
  chunkId: string
  score: number
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
  retrieve(question: string): Promise<Candidate[]>
  chunkCount: number
  backendName: string
}

/**
 * 建一个内存版的第一周系统。真实版在 D7 里连的是 pgvector，
 * 但检索逻辑与打分公式是同一份——评估要量的是逻辑，不是存储介质。
 */
export async function createWeek1Retriever(chunks: Chunk[]): Promise<Retriever> {
  const backend = createEmbedBackend()
  const index = buildBm25(chunks)
  const byId = new Map(chunks.map((c) => [c.chunkId, c]))
  // 一次把全部块向量化：30 篇语料几百个块，批量一次比逐条调省钱也省时间
  const vectors = await backend.embed(chunks.map((c) => `${c.headingPath.join(' ')}\n${c.text}`))

  return {
    chunkCount: chunks.length,
    backendName: backend.name,
    async retrieve(question) {
      const { perRouteTopK, weights, gates } = WEEK1_RETRIEVAL
      const raw = new Map<string, { bm25?: number; vector?: number }>()
      for (const hit of bm25Search(index, question, perRouteTopK)) {
        raw.set(hit.chunkId, { ...raw.get(hit.chunkId), bm25: hit.score })
      }
      const [qv] = await backend.embed([question])
      // 向量都做过 L2 归一化，所以内积就是余弦相似度，不用再除模长
      const cos = chunks
        .map((c, i) => ({
          chunkId: c.chunkId,
          score: vectors[i].reduce((s, x, j) => s + x * qv[j], 0),
        }))
        .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
        .slice(0, perRouteTopK)
      for (const hit of cos) raw.set(hit.chunkId, { ...raw.get(hit.chunkId), vector: hit.score })

      // 两路量纲不同，各自除以本路最高分压到 0–1 再加权。朴素但能用，D9 换成倒数排名融合
      const maxBm25 = Math.max(...[...raw.values()].map((r) => r.bm25 ?? 0), 1e-9)
      const maxVector = Math.max(...[...raw.values()].map((r) => r.vector ?? 0), 1e-9)

      return [...raw.entries()]
        .map(([chunkId, scores]) => {
          const chunk = byId.get(chunkId)
          if (!chunk) throw new Error(`索引里有一个语料里没有的块：${chunkId}`)
          const fused =
            ((scores.bm25 ?? 0) / maxBm25) * weights.bm25 +
            ((scores.vector ?? 0) / maxVector) * weights.vector
          // 门槛卡在原始分上：融合分是相对的，最不相干的那批也能拿到 1.0
          const admitted =
            (scores.bm25 ?? 0) >= gates.bm25MinScore ||
            (scores.vector ?? 0) >= gates.vectorMinCosine
          return { chunk, ...scores, fused, admitted }
        })
        .sort((a, b) => b.fused - a.fused || a.chunk.chunkId.localeCompare(b.chunk.chunkId))
    },
  }
}
