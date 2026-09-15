import type { Chunk } from './corpus'
import { createEmbedBackend, type EmbedBackend } from './embed'

/**
 * 两路检索，**各自独立**，各自输出一份有序的块号列表。
 *
 * 这是今天与 D7/D8 最大的结构差别：D7 的实现把两路揉在一个函数里、当场归一化加权，
 * 拿到的是一份混好的分数；今天两路各跑各的、各自排好队，
 * 合并交给 `fuse.ts` 里那个只看名次的函数——名次是两路唯一可比的东西。
 *
 * BM25 的公式、k1 与 b 的含义见 D1，本天不重讲，参数逐字沿用（换了就没法跟基线比）。
 */

/** 逐字沿用 D1/D7/D8 的 BM25 参数与门槛，改了今天的数字就跟 D8 基线不可比 */
export const RETRIEVAL = {
  bm25: { k1: 1.2, b: 0.75 },
  /** 卡片 3.7ter：每一路默认取前 50 */
  perRouteTopK: 50,
  /** 门槛沿用 D7：判「够不够得着」用的是每一路的原始分，不是融合分 */
  gates: { bm25MinScore: 6, vectorMinCosine: 0.2 },
}

export interface Scored {
  chunkId: string
  score: number
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

/** 同分按 chunkId 定序，保证跑几次名次都一样——名次不稳，后面的融合就没法复现 */
function bm25Search(index: Bm25Index, query: string, topK: number): Scored[] {
  const { k1, b } = RETRIEVAL.bm25
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

export interface Routes {
  chunkCount: number
  backendName: string
  byId: Map<string, Chunk>
  /** 关键词一路：字面对得上就给分，对不上一分没有 */
  bm25(query: string, topK?: number): Scored[]
  /** 向量一路：全库算余弦，只看方向不看字面 */
  vector(query: string, topK?: number): Promise<Scored[]>
}

/** 建两路索引。向量一路一次性把全部块向量化——几百个块，批量一次比逐条调省钱也省时间 */
export async function createRoutes(chunks: Chunk[]): Promise<Routes> {
  const backend: EmbedBackend = createEmbedBackend()
  const index = buildBm25(chunks)
  const byId = new Map(chunks.map((c) => [c.chunkId, c]))
  const vectors = await backend.embed(chunks.map((c) => `${c.headingPath.join(' ')}\n${c.text}`))

  return {
    chunkCount: chunks.length,
    backendName: backend.name,
    byId,
    bm25(query, topK = RETRIEVAL.perRouteTopK) {
      return bm25Search(index, query, topK)
    },
    async vector(query, topK = RETRIEVAL.perRouteTopK) {
      const [qv] = await backend.embed([query])
      // 向量都做过 L2 归一化，所以内积就是余弦相似度，不用再除模长
      return chunks
        .map((c, i) => ({
          chunkId: c.chunkId,
          score: vectors[i].reduce((s, x, j) => s + x * qv[j], 0),
        }))
        .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
        .slice(0, topK)
    },
  }
}
