import { getEncoding } from 'js-tiktoken'
import type { Chunk } from './corpus'
import type { Candidate } from './retrieve'
import type { Question } from './goldenset'

/**
 * 检索侧指标，逐字沿用 D8 的口径与实现（详细解释见 D8 的 `metrics.ts` 与那一天的正文）。
 * 本天不重新定义任何指标——重定义指标是「让数字变好看」最省事的作弊方式。
 */

const ENC = getEncoding('cl100k_base')
export const countTokens = (text: string): number => ENC.encode(text).length

/** 尺子是 token 预算不是「取前 k 块」，口径与 D4 / D8 一致，三天的数字才可比 */
export const CONTEXT_BUDGET = 600
/**
 * 多跳问题要同时装下两篇文档，600 token 常常只够装第一篇。
 * 意图路由认出多跳之后可以单独给它更高的预算——**分流的价值不只是省钱，
 * 还在于把省下来的钱花在真正需要的问题上**。这一档要单独计成本，不能和别的行混着读。
 */
export const MULTI_HOP_BUDGET = 1000
export const CANDIDATE_K = 20
export const NDCG_K = 10

export interface RetrievalTrace {
  id: string
  type: Question['type']
  answerDocIds: string[]
  rankedDocIds: string[]
  contextDocIds: string[]
  contextChunks: Chunk[]
  contextTokens: number
  relevantChunkCount: number
  admitted: boolean
}

export function packContext(
  candidates: Candidate[],
  budget: number = CONTEXT_BUDGET
): { chunks: Chunk[]; docIds: string[]; tokens: number } {
  const chunks: Chunk[] = []
  const docIds: string[] = []
  let tokens = 0
  for (const c of candidates) {
    const cost = countTokens(c.chunk.text)
    if (tokens + cost > budget) break // 预算装满就停，后面的名次一律进不来
    tokens += cost
    chunks.push(c.chunk)
    if (!docIds.includes(c.chunk.docId)) docIds.push(c.chunk.docId)
  }
  return { chunks, docIds, tokens }
}

/** 把一次检索的候选列表变成一条可以算指标的记录 */
export function traceOf(
  question: Question,
  candidates: Candidate[],
  allChunks: Chunk[],
  budget: number = CONTEXT_BUDGET
): RetrievalTrace {
  const ranked = candidates.slice(0, CANDIDATE_K)
  const admittedRanked = ranked.filter((c) => c.admitted)
  const packed = packContext(admittedRanked, budget)
  return {
    id: question.id,
    type: question.type,
    answerDocIds: question.answerDocIds,
    rankedDocIds: ranked.map((c) => c.chunk.docId),
    contextDocIds: packed.docIds,
    contextChunks: packed.chunks,
    contextTokens: packed.tokens,
    relevantChunkCount: allChunks.filter((c) => question.answerDocIds.includes(c.docId)).length,
    admitted: admittedRanked.length > 0,
  }
}

/** `single` 任意一篇进上下文即命中；`multi` 必须全部进。口径来自 D4，D8 沿用，本天照旧 */
export function isHit(t: RetrievalTrace): boolean {
  if (t.type === 'none') return false
  if (t.type === 'multi') return t.answerDocIds.every((id) => t.contextDocIds.includes(id))
  return t.answerDocIds.some((id) => t.contextDocIds.includes(id))
}

export function reciprocalRank(t: RetrievalTrace): number {
  if (t.type === 'none') return 0
  const rank = t.rankedDocIds.findIndex((id) => t.answerDocIds.includes(id))
  return rank === -1 ? 0 : 1 / (rank + 1)
}

export function ndcgAt(t: RetrievalTrace, k: number = NDCG_K): number {
  if (t.type === 'none' || t.relevantChunkCount === 0) return 0
  const gains: number[] = t.rankedDocIds
    .slice(0, k)
    .map((docId) => (t.answerDocIds.includes(docId) ? 1 : 0))
  const dcg = gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
  const ideal = Math.min(t.relevantChunkCount, k)
  let idcg = 0
  for (let i = 0; i < ideal; i += 1) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}

export interface RetrievalMetrics {
  recall: number
  recallSingle: number
  recallMulti: number
  mrr: number
  ndcg: number
  /** 无答案问题里检索侧正确闭嘴的比例。查询侧手法最容易踩坏的就是它 */
  abstainRate: number
  avgContextTokens: number
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4))

export function aggregate(traces: RetrievalTrace[]): RetrievalMetrics {
  const answerable = traces.filter((t) => t.type !== 'none')
  const singles = answerable.filter((t) => t.type === 'single')
  const multis = answerable.filter((t) => t.type === 'multi')
  const nones = traces.filter((t) => t.type === 'none')
  return {
    recall: mean(answerable.map((t) => (isHit(t) ? 1 : 0))),
    recallSingle: mean(singles.map((t) => (isHit(t) ? 1 : 0))),
    recallMulti: mean(multis.map((t) => (isHit(t) ? 1 : 0))),
    mrr: mean(answerable.map(reciprocalRank)),
    ndcg: mean(answerable.map((t) => ndcgAt(t))),
    abstainRate: mean(nones.map((t) => (t.admitted ? 0 : 1))),
    avgContextTokens: Number(
      (traces.reduce((s, t) => s + t.contextTokens, 0) / (traces.length || 1)).toFixed(1)
    ),
  }
}
