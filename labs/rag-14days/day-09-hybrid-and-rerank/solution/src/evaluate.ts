import { getEncoding } from 'js-tiktoken'
import type { Chunk } from './corpus'
import type { Question } from './goldenset'
import { FUSE_KEEP, PER_ROUTE_K, RRF_K, rrfFuse } from './fuse'
import { RETRIEVAL, type Routes, type Scored } from './retrieve'
import type { RerankBackend } from './rerank'

/**
 * 四档配置在同一把尺子下的对照。尺子逐字沿用 D8：
 * 600 token 上下文预算、候选池 20、nDCG@10、命中判定 single 任一 / multi 全部。
 * **只要动了这三个数，今天的数字就跟 D8 的基线不可比了。**
 */
export const CONTEXT_BUDGET = 600
export const CANDIDATE_K = FUSE_KEEP
export const NDCG_K = 10

const ENC = getEncoding('cl100k_base')
export const countTokens = (text: string): number => ENC.encode(text).length

/**
 * ⚠️ 下面两组是**占位值**，不是任何厂商的真实报价。
 *
 * 单价会变，而读者无从知道正文里的数字什么时候过期；写死一个具体价格，
 * 三个月后它就是一个看起来很合理的错数字。所以这里只放占位单价 + 环境变量覆盖，
 * 账里**唯一由实测撑着的是 token 数与调用次数**——那两个是真跑出来的。
 * 想看真实结论，去你要用的那家的定价页填进来再跑一遍。
 */
export const PRICES = {
  /** 每百万 token 的 embedding 价（占位） */
  embedPerMTok: Number(process.env.PRICE_EMBED_PER_MTOK ?? 0.02),
  /** 每千次重排检索的价（占位）。重排普遍按「检索次数」计价，不按 token */
  rerankPerKSearch: Number(process.env.PRICE_RERANK_PER_KSEARCH ?? 2.0),
}

/**
 * ⚠️ 同样是**占位值**。`MOCK=1` 下两路都在本地内存里算，没有任何网络往返，
 * 实测毫秒数只能说明「代码本身有多重」，不代表线上延迟。
 * 真实系统的延迟主要由这两次网络往返决定，所以下面单独建一个模型账。
 */
export const LATENCY_MODEL = {
  embedMs: Number(process.env.LAT_EMBED_MS ?? 120),
  rerankMs: Number(process.env.LAT_RERANK_MS ?? 180),
}

export type ConfigName = 'vector' | 'bm25' | 'hybrid' | 'hybrid+rerank'
export const CONFIGS: ConfigName[] = ['vector', 'bm25', 'hybrid', 'hybrid+rerank']

export interface QuestionTrace {
  id: string
  type: Question['type']
  answerDocIds: string[]
  /** 最终排序里每一名对应的文档号（同一篇会重复出现，名次不能去重） */
  rankedDocIds: string[]
  contextDocIds: string[]
  contextTokens: number
  relevantChunkCount: number
  admitted: boolean
  hit: boolean
  reciprocalRank: number
  ndcg: number
  /** 实测耗时（毫秒），MOCK 下不含任何网络往返 */
  elapsedMs: number
  embedTokens: number
  rerankInputTokens: number
  rerankCalls: number
}

export interface Metrics {
  recall: number
  recallSingle: number
  recallMulti: number
  mrr: number
  ndcg: number
  abstainRate: number
  avgContextTokens: number
}

export interface ConfigResult {
  name: ConfigName
  metrics: Metrics
  traces: QuestionTrace[]
  /** 实测：每问平均毫秒（MOCK 下纯本地计算） */
  measuredMsPerQuestion: number
  /** 建模：每问额外的网络往返毫秒（占位单价，见 LATENCY_MODEL） */
  modeledNetworkMsPerQuestion: number
  embedTokensPerQuestion: number
  rerankCallsPerQuestion: number
  rerankInputTokensPerQuestion: number
  /** 每一千次提问的检索侧费用（占位单价） */
  costPerKQueries: number
}

// ---------------------------------------------------------------------------
// 指标：沿用 D8 的三个实现，口径一个字不改
// ---------------------------------------------------------------------------

function packContext(candidates: Chunk[]): { docIds: string[]; tokens: number } {
  const docIds: string[] = []
  let tokens = 0
  for (const chunk of candidates) {
    const cost = countTokens(chunk.text)
    if (tokens + cost > CONTEXT_BUDGET) break // 预算装满就停，后面的名次一律进不来
    tokens += cost
    if (!docIds.includes(chunk.docId)) docIds.push(chunk.docId)
  }
  return { docIds, tokens }
}

function isHit(t: Omit<QuestionTrace, 'hit' | 'reciprocalRank' | 'ndcg'>): boolean {
  if (t.type === 'none') return false
  if (t.type === 'multi') return t.answerDocIds.every((id) => t.contextDocIds.includes(id))
  return t.answerDocIds.some((id) => t.contextDocIds.includes(id))
}

function reciprocalRank(rankedDocIds: string[], answerDocIds: string[]): number {
  const rank = rankedDocIds.findIndex((id) => answerDocIds.includes(id))
  return rank === -1 ? 0 : 1 / (rank + 1)
}

function ndcgAt(rankedDocIds: string[], answerDocIds: string[], relevantChunks: number): number {
  if (relevantChunks === 0) return 0
  const gains: number[] = rankedDocIds
    .slice(0, NDCG_K)
    .map((id) => (answerDocIds.includes(id) ? 1 : 0))
  const dcg = gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
  let idcg = 0
  for (let i = 0; i < Math.min(relevantChunks, NDCG_K); i += 1) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4))

function aggregate(traces: QuestionTrace[]): Metrics {
  const answerable = traces.filter((t) => t.type !== 'none')
  const nones = traces.filter((t) => t.type === 'none')
  return {
    recall: mean(answerable.map((t) => (t.hit ? 1 : 0))),
    recallSingle: mean(answerable.filter((t) => t.type === 'single').map((t) => (t.hit ? 1 : 0))),
    recallMulti: mean(answerable.filter((t) => t.type === 'multi').map((t) => (t.hit ? 1 : 0))),
    mrr: mean(answerable.map((t) => t.reciprocalRank)),
    ndcg: mean(answerable.map((t) => t.ndcg)),
    abstainRate: mean(nones.map((t) => (t.admitted ? 0 : 1))),
    avgContextTokens: Number(
      (traces.reduce((s, t) => s + t.contextTokens, 0) / (traces.length || 1)).toFixed(1)
    ),
  }
}

// ---------------------------------------------------------------------------
// 四档配置：唯一的差别在「最终那份有序列表是怎么来的」
// ---------------------------------------------------------------------------

async function rankFor(
  config: ConfigName,
  routes: Routes,
  reranker: RerankBackend,
  query: string,
  perRouteK: number
): Promise<{
  ranked: Scored[]
  raw: Map<string, { bm25?: number; vector?: number }>
  rerankInputTokens: number
  rerankCalls: number
}> {
  const raw = new Map<string, { bm25?: number; vector?: number }>()
  const note = (id: string, patch: { bm25?: number; vector?: number }): void => {
    raw.set(id, { ...raw.get(id), ...patch })
  }

  if (config === 'bm25') {
    const hits = routes.bm25(query, perRouteK)
    for (const h of hits) note(h.chunkId, { bm25: h.score })
    return { ranked: hits.slice(0, CANDIDATE_K), raw, rerankInputTokens: 0, rerankCalls: 0 }
  }
  if (config === 'vector') {
    const hits = await routes.vector(query, perRouteK)
    for (const h of hits) note(h.chunkId, { vector: h.score })
    return { ranked: hits.slice(0, CANDIDATE_K), raw, rerankInputTokens: 0, rerankCalls: 0 }
  }

  // 两路并行跑：BM25 是同步的纯内存计算，向量那一路要等一次 embedding
  const [keyword, vector] = await Promise.all([
    Promise.resolve(routes.bm25(query, perRouteK)),
    routes.vector(query, perRouteK),
  ])
  for (const h of keyword) note(h.chunkId, { bm25: h.score })
  for (const h of vector) note(h.chunkId, { vector: h.score })

  const fused = rrfFuse([keyword.map((h) => h.chunkId), vector.map((h) => h.chunkId)], RRF_K).slice(
    0,
    FUSE_KEEP
  )

  if (config === 'hybrid') {
    return {
      ranked: fused.map((f) => ({ chunkId: f.id, score: f.score })),
      raw,
      rerankInputTokens: 0,
      rerankCalls: 0,
    }
  }

  // 只对融合后的前 20 条重排。全库 134 块重排要多跑 6.7 倍的前向，收益却几乎全在这前 20 条里
  const docs = fused.map((f) => {
    const chunk = routes.byId.get(f.id)
    if (!chunk) throw new Error(`索引里有一个语料里没有的块：${f.id}`)
    return { id: f.id, text: chunk.text }
  })
  const scored = await reranker.rerank(query, docs)
  const rerankInputTokens = countTokens(query) + docs.reduce((s, d) => s + countTokens(d.text), 0)
  return {
    ranked: scored.map((s) => ({ chunkId: s.id, score: s.score })),
    raw,
    rerankInputTokens,
    rerankCalls: 1,
  }
}

/**
 * 检索侧的每千次提问要花多少钱（占位单价）。
 *
 * 两笔：向量那一路要把**查询**向量化一次（文档向量是离线算好的，不进这笔账）；
 * 重排按「检索次数」计价，一次提问不管送 20 条还是 100 条都算一次检索——
 * 这正是为什么重排的钱是**按问计费**，而不是按块计费。
 */
export function estimateCost(
  embedTokensPerQuestion: number,
  rerankCallsPerQuestion: number
): number {
  const embed = (embedTokensPerQuestion / 1_000_000) * PRICES.embedPerMTok * 1000
  const rerank = rerankCallsPerQuestion * PRICES.rerankPerKSearch
  return Number((embed + rerank).toFixed(4))
}

export async function runConfig(
  config: ConfigName,
  routes: Routes,
  reranker: RerankBackend,
  questions: Question[],
  chunks: Chunk[],
  perRouteK: number = PER_ROUTE_K
): Promise<ConfigResult> {
  const traces: QuestionTrace[] = []
  for (const q of questions) {
    const started = performance.now()
    const { ranked, raw, rerankInputTokens, rerankCalls } = await rankFor(
      config,
      routes,
      reranker,
      q.question,
      perRouteK
    )
    const elapsedMs = performance.now() - started

    // 门槛卡在**每一路的原始分**上，不是融合分：融合分是相对的，最不相干的那批也能拿到本次最高
    const admittedChunks = ranked
      .filter((r) => {
        const s = raw.get(r.chunkId) ?? {}
        return (
          (s.bm25 ?? -Infinity) >= RETRIEVAL.gates.bm25MinScore ||
          (s.vector ?? -Infinity) >= RETRIEVAL.gates.vectorMinCosine
        )
      })
      .map((r) => routes.byId.get(r.chunkId))
      .filter((c): c is Chunk => Boolean(c))

    const packed = packContext(admittedChunks)
    const rankedDocIds = ranked.map((r) => routes.byId.get(r.chunkId)?.docId ?? '')
    const base = {
      id: q.id,
      type: q.type,
      answerDocIds: q.answerDocIds,
      rankedDocIds,
      contextDocIds: packed.docIds,
      contextTokens: packed.tokens,
      relevantChunkCount: chunks.filter((c) => q.answerDocIds.includes(c.docId)).length,
      admitted: admittedChunks.length > 0,
      elapsedMs,
      embedTokens: config === 'bm25' ? 0 : countTokens(q.question),
      rerankInputTokens,
      rerankCalls,
    }
    traces.push({
      ...base,
      hit: isHit(base),
      reciprocalRank: q.type === 'none' ? 0 : reciprocalRank(rankedDocIds, q.answerDocIds),
      ndcg: q.type === 'none' ? 0 : ndcgAt(rankedDocIds, q.answerDocIds, base.relevantChunkCount),
    })
  }

  const n = traces.length || 1
  const embedTokensPerQuestion = traces.reduce((s, t) => s + t.embedTokens, 0) / n
  const rerankCallsPerQuestion = traces.reduce((s, t) => s + t.rerankCalls, 0) / n
  const rerankInputTokensPerQuestion = traces.reduce((s, t) => s + t.rerankInputTokens, 0) / n
  const costPerKQueries = estimateCost(embedTokensPerQuestion, rerankCallsPerQuestion)

  return {
    name: config,
    metrics: aggregate(traces),
    traces,
    measuredMsPerQuestion: Number((traces.reduce((s, t) => s + t.elapsedMs, 0) / n).toFixed(2)),
    modeledNetworkMsPerQuestion: Number(
      (
        (config === 'bm25' ? 0 : LATENCY_MODEL.embedMs) +
        rerankCallsPerQuestion * LATENCY_MODEL.rerankMs
      ).toFixed(1)
    ),
    embedTokensPerQuestion: Number(embedTokensPerQuestion.toFixed(1)),
    rerankCallsPerQuestion,
    rerankInputTokensPerQuestion: Number(rerankInputTokensPerQuestion.toFixed(1)),
    costPerKQueries,
  }
}

/**
 * 两路各自的盲区：哪些题只有关键词一路能命中、哪些只有向量一路能命中。
 * 这是「为什么要混合」最直接的证据——**不是靠讲道理，是靠列出来**。
 */
export function blindSpots(
  bm25: ConfigResult,
  vector: ConfigResult
): { onlyBm25: string[]; onlyVector: string[]; neither: string[] } {
  const byId = new Map(vector.traces.map((t) => [t.id, t]))
  const onlyBm25: string[] = []
  const onlyVector: string[] = []
  const neither: string[] = []
  for (const t of bm25.traces) {
    if (t.type === 'none') continue
    const v = byId.get(t.id)
    if (!v) continue
    if (t.hit && !v.hit) onlyBm25.push(t.id)
    else if (!t.hit && v.hit) onlyVector.push(t.id)
    else if (!t.hit && !v.hit) neither.push(t.id)
  }
  return { onlyBm25, onlyVector, neither }
}
