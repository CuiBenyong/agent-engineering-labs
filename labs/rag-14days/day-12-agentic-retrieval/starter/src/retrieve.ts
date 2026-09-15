import { getEncoding } from 'js-tiktoken'
import type { Chunk, Department } from './corpus'
import { createEmbedBackend } from './embed'

/**
 * 检索这一层：混合检索（BM25 + 向量）→ 倒数排名融合 → 重排。
 *
 * 规格逐条来自课程连贯性卡片 §3.7ter（D9 定的口径），本天**不改一个参数**——
 * 今天要量的是「循环」带来的变化，检索器一改，两组数字就不可比了。
 * 这个文件读一遍就可以跳过，本天的教学内容在 `reflect.ts` 与 `agent.ts` 里。
 */

const ENC = getEncoding('cl100k_base')
export const countTokens = (text: string): number => ENC.encode(text).length

/** k = 60 是倒数排名融合原论文的常用取值，全课统一，不要各天各调一个 */
const RRF_K = 60
/** 每一路各取前 50，融合后留前 20 交给重排。重排只作用于这 20 条，不许对全库重排 */
const PER_ROUTE_TOP_K = 50
const FUSE_KEEP = 20
/**
 * 门槛卡在**原始分**上：融合分是相对名次，最不相干的那批也能拿到高分。
 * 默认值逐字取自 D7 的 `rag.config.json`，与 D8 的基线报告同一套。
 */
export interface Gates {
  bm25MinScore: number
  vectorMinCosine: number
}
export const DEFAULT_GATES: Gates = { bm25MinScore: 6, vectorMinCosine: 0.2 }
/** 放宽档：自评判定「材料不完整」时改用它重查一轮，把被门槛误伤的候选放回来 */
export const RELAXED_GATES: Gates = { bm25MinScore: 2, vectorMinCosine: 0.1 }
const BM25 = { k1: 1.2, b: 0.75 }
/** 上下文预算口径与 D4 / D8 完全一致，三天的数字才可比 */
export const CONTEXT_BUDGET = 600

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

function bm25Search(index: Bm25Index, query: string, pool: string[]): Array<[string, number]> {
  const { k1, b } = BM25
  const terms = tokenize(query)
  const allowed = new Set(pool)
  const candidates = new Set<string>()
  for (const term of terms) {
    for (const id of index.postings.get(term)?.keys() ?? []) {
      if (allowed.has(id)) candidates.add(id)
    }
  }
  return [...candidates]
    .map((chunkId): [string, number] => {
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
      return [chunkId, score]
    })
    .sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))
    .slice(0, PER_ROUTE_TOP_K)
}

/**
 * 倒数排名融合：只看名次不看分数，因为两路的分数量纲不可比、归一化也不稳。
 * 同分必须按 id 兜底排序，否则跨天跑同一份数据名次会飘，评估数字跟着飘。
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
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
}

/**
 * 重排（cross-encoder）的统一接口。MOCK 下必须是**确定性替身**，不许调网络：
 * 用「查询词元与文档词元的加权重合度」打分即可。它只验证代码路径，
 * **不代表真实交叉编码器的效果**——真实模型能读懂语序和否定，重合度不能。
 */
export type Reranker = (
  query: string,
  docs: Array<{ id: string; text: string }>
) => Promise<Array<{ id: string; score: number }>>

export const overlapReranker: Reranker = async (query, docs) => {
  const qTerms = [...new Set(tokenize(query))]
  return docs
    .map(({ id, text }) => {
      const inDoc = new Set(tokenize(text))
      const hit = qTerms.filter((t) => inDoc.has(t)).length
      return { id, score: qTerms.length === 0 ? 0 : hit / qTerms.length }
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

export interface Candidate {
  chunk: Chunk
  /** 每一路的原始分。没进那一路就是 undefined，不要拿 0 冒充 */
  bm25?: number
  vector?: number
  rrf: number
  rerank: number
  /** 至少有一路认为这条「够得着」。检索侧要不要再查一轮、要不要拒答，看的就是它 */
  admitted: boolean
}

export interface SearchOptions {
  /** 只在这个部门里查。工具把它暴露给模型，是为了让模型能主动收窄范围 */
  department?: Department
  /** 返回多少条。放宽检索时把它调大 */
  topK?: number
  /**
   * 降级放宽：换成 RELAXED_GATES 重判一遍准入。
   * 它救的是「检索到了却被自己的过滤器扔掉」那一类失败，跟多跳不是一回事。
   */
  relaxGate?: boolean
}

export interface Retriever {
  search(query: string, opts?: SearchOptions): Promise<Candidate[]>
  chunkCount: number
  backendName: string
}

export interface RetrieverOptions {
  rerank?: Reranker
  /** 覆盖默认准入门槛。演示「门槛把答案挡在外面」时要用它 */
  gates?: Gates
}

export async function createRetriever(
  chunks: Chunk[],
  { rerank = overlapReranker, gates = DEFAULT_GATES }: RetrieverOptions = {}
): Promise<Retriever> {
  const backend = createEmbedBackend()
  const index = buildBm25(chunks)
  const byId = new Map(chunks.map((c) => [c.chunkId, c]))
  // 一次把全部块向量化：30 篇语料一百多块，批量一次比逐条调省钱也省时间
  const vectors = await backend.embed(chunks.map((c) => `${c.headingPath.join(' ')}\n${c.text}`))
  const vectorById = new Map(chunks.map((c, i) => [c.chunkId, vectors[i]]))

  return {
    chunkCount: chunks.length,
    backendName: backend.name,
    async search(query, opts = {}) {
      const pool = chunks
        .filter((c) => !opts.department || c.department === opts.department)
        .map((c) => c.chunkId)

      const bm25Hits = bm25Search(index, query, pool)
      const [qv] = await backend.embed([query])
      // 向量都做过 L2 归一化，所以内积就是余弦相似度，不用再除模长
      const vectorHits = pool
        .map((id): [string, number] => [
          id,
          (vectorById.get(id) ?? []).reduce((s, x, j) => s + x * qv[j], 0),
        ])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, PER_ROUTE_TOP_K)

      const bm25Raw = new Map(bm25Hits)
      const vectorRaw = new Map(vectorHits)
      const fused = rrfFuse([bm25Hits.map(([id]) => id), vectorHits.map(([id]) => id)]).slice(
        0,
        FUSE_KEEP
      )

      // 重排只作用于融合后的前 20 条：交叉编码器要把查询和文档拼在一起过一遍模型，
      // 成本随候选数线性涨，对全库重排在生产里是不可接受的
      const reranked = await rerank(
        query,
        fused.map(({ id }) => ({ id, text: byId.get(id)?.text ?? '' }))
      )
      const rrfById = new Map(fused.map((f) => [f.id, f.score]))

      const gate = opts.relaxGate ? RELAXED_GATES : gates
      return reranked.slice(0, opts.topK ?? FUSE_KEEP).map(({ id, score }) => {
        const chunk = byId.get(id)
        if (!chunk) throw new Error(`索引里有一个语料里没有的块：${id}`)
        const bm25 = bm25Raw.get(id)
        const vector = vectorRaw.get(id)
        return {
          chunk,
          bm25,
          vector,
          rrf: rrfById.get(id) ?? 0,
          rerank: score,
          admitted: (bm25 ?? 0) >= gate.bm25MinScore || (vector ?? 0) >= gate.vectorMinCosine,
        }
      })
    },
  }
}

/** 按 token 预算装上下文，口径与 D4 / D8 一致：按名次往里装，装满就停 */
export function packContext(
  candidates: Candidate[],
  budget: number = CONTEXT_BUDGET
): {
  chunks: Chunk[]
  docIds: string[]
  tokens: number
} {
  const chunks: Chunk[] = []
  const docIds: string[] = []
  const seen = new Set<string>()
  let tokens = 0
  for (const c of candidates) {
    if (seen.has(c.chunk.chunkId)) continue
    const cost = countTokens(c.chunk.text)
    if (tokens + cost > budget) break
    seen.add(c.chunk.chunkId)
    tokens += cost
    chunks.push(c.chunk)
    if (!docIds.includes(c.chunk.docId)) docIds.push(c.chunk.docId)
  }
  return { chunks, docIds, tokens }
}
