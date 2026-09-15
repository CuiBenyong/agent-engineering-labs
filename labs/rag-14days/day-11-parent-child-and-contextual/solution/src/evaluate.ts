import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Chunk } from './corpus'
import { countTokens } from './cost'
import { indexTextOf } from './indexes'
import type { Retriever } from './retrieve'

/**
 * 评估口径与 D4 / D8 完全一致，三天的数字才可比：
 * 600 token 上下文预算、候选池 20、single 任意一篇进上下文即命中、multi 必须全进。
 * 指标的定义与实现在 D8，这里只是照用。
 *
 * **不要看平均倒数排名**：D8 已经量出它在这份语料上顶格 1.0，是指标饱和不是系统满分。
 * 本天用召回率、答案文档平均名次、nDCG@10 三个还有区分度的指标。
 */

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval')

export const CONTEXT_BUDGET = 600
export const CANDIDATE_K = 20
export const NDCG_K = 10

export interface Question {
  id: string
  question: string
  answerDocIds: string[]
  type: 'single' | 'multi' | 'none'
}

export function loadGoldenSet(): Question[] {
  return JSON.parse(readFileSync(join(EVAL_DIR, 'golden-set.json'), 'utf8')) as Question[]
}

export interface QuestionResult {
  id: string
  type: Question['type']
  hit: boolean
  /** 预算内装进上下文的文档，按名次去重 */
  contextDocIds: string[]
  contextTokens: number
  usedUnits: number
  /** 凑齐答案所需文档在候选池里的名次（multi 取最靠后那篇；没出现记为候选池长度加一） */
  bestRank: number
}

export interface EvalResult {
  name: string
  chunkCount: number
  indexTokens: number
  recall: number
  recallSingle: number
  recallMulti: number
  avgBestRank: number
  ndcg: number
  avgContextTokens: number
  avgUsedUnits: number
  perQuestion: QuestionResult[]
}

/**
 * 按 token 预算装上下文。父子索引在这一步分叉：
 * 命中的是子块，但真正装进提示词的是它的父块，成本也要按父块算。
 * 同一个父块被多个子块命中时只装一次——不去重的话一个父块会重复占掉几百 token。
 */
export function packContext(
  rankedIds: string[],
  byId: Map<string, Chunk>,
  parents: Map<string, Chunk>,
  contextText: (chunk: Chunk) => string
): { docIds: string[]; tokens: number; units: number } {
  const docIds: string[] = []
  const seenParents = new Set<string>()
  let tokens = 0
  let units = 0

  for (const id of rankedIds) {
    const chunk = byId.get(id)
    if (!chunk) continue
    const parent = chunk.parentId ? parents.get(chunk.parentId) : undefined
    if (parent && seenParents.has(parent.chunkId)) continue // 父块已经在上下文里了，跳过
    const unit = parent ?? chunk
    const cost = countTokens(parent ? unit.text : contextText(chunk))
    if (tokens + cost > CONTEXT_BUDGET) break // 预算装满就停，后面的名次一律进不来
    if (parent) seenParents.add(parent.chunkId)
    tokens += cost
    units += 1
    if (!docIds.includes(chunk.docId)) docIds.push(chunk.docId)
  }
  return { docIds, tokens, units }
}

/** 折损累计增益：名次越靠后，同样的相关块贡献越小。相关性是二元的（属不属于答案文档） */
function dcg(gains: number[]): number {
  return gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
}

function ndcgAt(rankedDocIds: string[], answerDocIds: string[], relevantCount: number): number {
  if (answerDocIds.length === 0) return 0
  const gains = rankedDocIds.slice(0, NDCG_K).map((d) => (answerDocIds.includes(d) ? 1 : 0))
  const ideal = Array.from({ length: Math.min(NDCG_K, relevantCount) }, () => 1)
  const idealDcg = dcg(ideal)
  return idealDcg === 0 ? 0 : dcg(gains) / idealDcg
}

export async function evaluate(
  name: string,
  retriever: Retriever,
  chunks: Chunk[],
  parents: Map<string, Chunk>,
  questions: Question[],
  indexTokens: number,
  indexText: (chunk: Chunk) => string = indexTextOf,
  /**
   * 装进上下文的文本可以和进索引的文本**不是同一份**。
   * 块头只在检索时有用，进了上下文就只是在每次查询里白占预算——
   * 这一行是本天最实用的一条工程结论，表一的最后一行就是靠它。
   */
  contextText: (chunk: Chunk) => string = indexText
): Promise<EvalResult> {
  const byId = new Map(chunks.map((c) => [c.chunkId, c]))
  const perQuestion: QuestionResult[] = []

  for (const q of questions) {
    const ranked = (await retriever.search(q.question)).slice(0, CANDIDATE_K)
    const rankedDocIds = ranked.map((id) => byId.get(id)?.docId ?? '')
    const packed = packContext(ranked, byId, parents, contextText)

    const hit =
      q.type === 'multi'
        ? q.answerDocIds.every((id) => packed.docIds.includes(id))
        : q.type === 'single'
          ? q.answerDocIds.some((id) => packed.docIds.includes(id))
          : false

    // 名次取「凑齐答案所需的最后一篇文档」第一次出现的位置：
    // 多跳题只捞到其中一篇不算数，这样名次和命中判据说的是同一件事
    const rankOf = (docId: string): number => {
      const at = rankedDocIds.indexOf(docId)
      return at < 0 ? CANDIDATE_K + 1 : at + 1
    }
    const ranks = q.answerDocIds.map(rankOf)
    const bestRank =
      ranks.length === 0
        ? CANDIDATE_K + 1
        : q.type === 'multi'
          ? Math.max(...ranks)
          : Math.min(...ranks)

    perQuestion.push({
      id: q.id,
      type: q.type,
      hit,
      contextDocIds: packed.docIds,
      contextTokens: packed.tokens,
      usedUnits: packed.units,
      bestRank,
    })
  }

  const relevantCountOf = (q: Question): number =>
    chunks.filter((c) => q.answerDocIds.includes(c.docId)).length
  const answerable = questions.filter((q) => q.type !== 'none')
  const byType = (t: Question['type']): QuestionResult[] => perQuestion.filter((r) => r.type === t)
  const rate = (rows: QuestionResult[]): number =>
    rows.length === 0 ? 0 : Number((rows.filter((r) => r.hit).length / rows.length).toFixed(4))

  const answerableResults = perQuestion.filter((r) => r.type !== 'none')
  const ndcgValues = await Promise.all(
    answerable.map(async (q) => {
      const ranked = (await retriever.search(q.question)).slice(0, CANDIDATE_K)
      return ndcgAt(
        ranked.map((id) => byId.get(id)?.docId ?? ''),
        q.answerDocIds,
        relevantCountOf(q)
      )
    })
  )

  return {
    name,
    chunkCount: chunks.length,
    indexTokens,
    recall: rate(answerableResults),
    recallSingle: rate(byType('single')),
    recallMulti: rate(byType('multi')),
    avgBestRank: Number(
      (
        answerableResults.reduce((s, r) => s + r.bestRank, 0) / (answerableResults.length || 1)
      ).toFixed(2)
    ),
    ndcg: Number((ndcgValues.reduce((s, n) => s + n, 0) / (ndcgValues.length || 1)).toFixed(4)),
    avgContextTokens: Math.round(
      perQuestion.reduce((s, r) => s + r.contextTokens, 0) / (perQuestion.length || 1)
    ),
    avgUsedUnits: Number(
      (perQuestion.reduce((s, r) => s + r.usedUnits, 0) / (perQuestion.length || 1)).toFixed(1)
    ),
    perQuestion,
  }
}
