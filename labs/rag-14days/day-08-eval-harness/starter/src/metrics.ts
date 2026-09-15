import { getEncoding } from 'js-tiktoken'
import type { Chunk } from './corpus'
import type { Candidate, Retriever } from './retrieve'
import type { Question } from './goldenset'

/**
 * 检索侧的三个指标。这个文件是本天的教学核心，请逐行读。
 *
 * 三个指标问的是三个不同的问题：
 *   召回率  ——「答案到底进没进上下文」，管的是有没有
 *   平均倒数排名——「进来的时候排第几」，管的是靠不靠前
 *   归一化折损累计增益——「整个排序好不好」，管的是前几名整体质量
 * 只看一个会瞎。三个一起看才知道故障出在哪一层，见正文。
 */

const ENC = getEncoding('cl100k_base')
export const countTokens = (text: string): number => ENC.encode(text).length

/**
 * 对照的尺子是 **token 预算**，不是「取前 k 块」。口径与 D4 完全一致，两天的数字才可比。
 * 按名次往里装，装满就停——谁能在同样的预算里放进更多有用信息，谁才是真的赢。
 */
export const CONTEXT_BUDGET = 600
/** 打分候选池：算名次类指标之前先取这么多块 */
export const CANDIDATE_K = 20
/** 归一化折损累计增益只看前几名，看太深没有意义——用户不会翻到第 20 条 */
export const NDCG_K = 10

export interface RetrievalTrace {
  id: string
  type: Question['type']
  answerDocIds: string[]
  /** 候选池里每一名对应的文档号，按名次排列（同一篇会重复出现，名次不能去重） */
  rankedDocIds: string[]
  /** 预算内真正装进上下文的文档，按名次去重 */
  contextDocIds: string[]
  contextChunks: Chunk[]
  contextTokens: number
  /** 全库有多少块属于答案文档——算理想排序时要用 */
  relevantChunkCount: number
  /** 至少有一条候选过了门槛。检索侧要不要拒答看的就是它 */
  admitted: boolean
  topFused: number
}

/** 按 token 预算装上下文：这是「进没进上下文」这句话的确切含义 */
export function packContext(candidates: Candidate[]): {
  chunks: Chunk[]
  docIds: string[]
  tokens: number
} {
  const chunks: Chunk[] = []
  const docIds: string[] = []
  let tokens = 0
  for (const c of candidates) {
    const cost = countTokens(c.chunk.text)
    if (tokens + cost > CONTEXT_BUDGET) break // 预算装满就停，后面的名次一律进不来
    tokens += cost
    chunks.push(c.chunk)
    if (!docIds.includes(c.chunk.docId)) docIds.push(c.chunk.docId)
  }
  return { chunks, docIds, tokens }
}

export async function trace(
  retriever: Retriever,
  question: Question,
  allChunks: Chunk[]
): Promise<RetrievalTrace> {
  const ranked = (await retriever.retrieve(question.question)).slice(0, CANDIDATE_K)
  const admittedRanked = ranked.filter((c) => c.admitted)
  const packed = packContext(admittedRanked)
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
    topFused: ranked[0]?.fused ?? 0,
  }
}

// ---------------------------------------------------------------------------
// 指标一：召回率（命中了没有）
// ---------------------------------------------------------------------------

/**
 * 命中判定沿用 D4 的口径，不许在这一天另发明一个：
 * `single` 的答案文档列了多篇时，任意一篇进上下文即命中；`multi` 必须全部进。
 * `none` 类没有答案文档，不参与召回率，它有自己的指标（拒答率）。
 *
 * 为什么 multi 要求全部：多跳问题少一篇就答不出来，算「命中一半」等于给自己发安慰奖。
 */
export function isHit(t: RetrievalTrace): boolean {
  if (t.type === 'none') return false
  // 练习 1：按 D4 的口径判命中。`t.contextDocIds` 是预算内装进上下文的文档号。
  //   single：答案文档里**任意一篇**在里面就算命中
  //   multi ：**全部**答案文档都在里面才算命中
  // 提示：两种口径分别对应数组的 some 与 every，写反了 multi 的召回率会虚高一大截。
  void t
  return false
}

// ---------------------------------------------------------------------------
// 指标二：倒数排名（排在第几）
// ---------------------------------------------------------------------------

/**
 * 第一条相关结果的名次取倒数：排第 1 得 1，排第 2 得 0.5，排第 10 得 0.1，没找到得 0。
 * 全部问题上取平均就是平均倒数排名（MRR）。
 *
 * 它只看**第一条**相关结果，所以对「答案还在、只是被挤到后面」极其敏感——
 * 而召回率在预算没被挤爆之前完全看不出这件事。这正是两个指标要一起看的原因。
 */
export function reciprocalRank(t: RetrievalTrace): number {
  if (t.type === 'none') return 0
  // 练习 2：在 `t.rankedDocIds`（按名次排列，同一篇可能重复出现）里找到
  // 第一条属于答案文档的位置，返回它名次的倒数；一条都没有返回 0。
  // 提示：数组下标从 0 起，名次从 1 起——差一位会让所有分数偏高。
  void t
  return 0
}

// ---------------------------------------------------------------------------
// 指标三：归一化折损累计增益（整体排序好不好）
// ---------------------------------------------------------------------------

/**
 * 折损累计增益：第 i 名的收益按 1 / log2(i + 1) 打折，越靠后折得越狠；
 * 再除以「理想排序」（所有相关块都排在最前面）能拿到的分数，归一化到 0–1。
 *
 * 它和倒数排名的区别：倒数排名只认第一条，第 2 名和第 9 名同时相关它一视同仁；
 * 归一化折损累计增益把前 k 名里**每一条**相关结果都算进去，
 * 所以「一条命中 + 九条垃圾」和「五条全命中」在它这里分得很开。
 * 重排（D9）优化的正是这一项。
 */
export function ndcgAt(t: RetrievalTrace, k: number = NDCG_K): number {
  if (t.type === 'none' || t.relevantChunkCount === 0) return 0
  // 练习 3：算归一化折损累计增益。三步：
  //   1. 前 k 名每一名的收益：属于答案文档记 1，否则记 0；
  //   2. 折损累计增益 = 各名次收益除以 log2(名次 + 1) 之后求和（名次从 1 起算）；
  //   3. 除以理想排序的分数：把 min(t.relevantChunkCount, k) 条相关块全排在最前面能拿多少。
  // 提示：分母那一项容易写成 log2(i + 1) 而在第一名上除以 0，注意下标与名次差一位。
  void t
  void k
  return 0
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export interface RetrievalMetrics {
  answerable: number
  recall: number
  recallSingle: number
  recallMulti: number
  mrr: number
  ndcg: number
  /** 无答案问题里检索侧正确闭嘴的比例。它和召回率是一对，只看一个会被骗 */
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
    answerable: answerable.length,
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
