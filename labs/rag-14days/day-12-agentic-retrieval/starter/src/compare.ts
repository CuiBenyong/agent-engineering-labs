import type { Question } from './goldenset'
import type { Assessor } from './reflect'
import type { Retriever } from './retrieve'
import { runAgenticRetrieval, runFixedRetrieval, type StopReason } from './agent'

/**
 * 固定流程 vs Agentic 流程，在 D8 那份 20 题标准答案集上跑一遍，**三笔账一起报**：
 * 指标涨了多少、延迟涨了多少、调用次数涨了多少。只报第一笔的对比是没有说服力的。
 */

/** 命中判定沿用 D4 / D8 的口径，不许在这一天另发明一个 */
function isHit(q: Question, contextDocIds: string[]): boolean {
  if (q.type === 'none') return false
  if (q.type === 'multi') return q.answerDocIds.every((id) => contextDocIds.includes(id))
  return q.answerDocIds.some((id) => contextDocIds.includes(id))
}

export interface Row {
  id: string
  type: Question['type']
  fixedHit: boolean
  agenticHit: boolean
  rounds: number
  stopReason: StopReason
  fixedMs: number
  agenticMs: number
  retrievalCalls: number
  assessCalls: number
  contextTokens: number
}

export interface Summary {
  recall: number
  recallSingle: number
  recallMulti: number
  abstainRate: number
  avgRetrievalCalls: number
  avgAssessCalls: number
  avgMs: number
  avgContextTokens: number
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4))

export async function compare(
  questions: Question[],
  retriever: Retriever,
  assess: Assessor
): Promise<{ rows: Row[]; fixed: Summary; agentic: Summary }> {
  const rows: Row[] = []
  const fixedAbstain: number[] = []
  const agenticAbstain: number[] = []
  const fixedTokens: number[] = []
  const agenticTokens: number[] = []

  for (const q of questions) {
    const fixed = await runFixedRetrieval(q.question, retriever)
    const agentic = await runAgenticRetrieval(q.question, { retriever, assess })
    rows.push({
      id: q.id,
      type: q.type,
      fixedHit: isHit(q, fixed.contextDocIds),
      agenticHit: isHit(q, agentic.contextDocIds),
      rounds: agentic.hops.length,
      stopReason: agentic.stopReason,
      fixedMs: fixed.elapsedMs,
      agenticMs: agentic.elapsedMs,
      retrievalCalls: agentic.retrievalCalls,
      assessCalls: agentic.assessCalls,
      contextTokens: agentic.contextTokens,
    })
    if (q.type === 'none') {
      fixedAbstain.push(fixed.admitted ? 0 : 1)
      // Agentic 的拒答口径：循环跑完仍然判「材料不够」，就是检索侧的一次正确闭嘴
      agenticAbstain.push(agentic.stopReason === 'sufficient' ? 0 : 1)
    }
    fixedTokens.push(fixed.contextTokens)
    agenticTokens.push(agentic.contextTokens)
  }

  const answerable = rows.filter((r) => r.type !== 'none')
  const singles = answerable.filter((r) => r.type === 'single')
  const multis = answerable.filter((r) => r.type === 'multi')

  const summarize = (pick: 'fixed' | 'agentic'): Summary => {
    const hit = (r: Row): number => ((pick === 'fixed' ? r.fixedHit : r.agenticHit) ? 1 : 0)
    return {
      recall: mean(answerable.map(hit)),
      recallSingle: mean(singles.map(hit)),
      recallMulti: mean(multis.map(hit)),
      abstainRate: mean(pick === 'fixed' ? fixedAbstain : agenticAbstain),
      avgRetrievalCalls: pick === 'fixed' ? 1 : mean(rows.map((r) => r.retrievalCalls)),
      avgAssessCalls: pick === 'fixed' ? 0 : mean(rows.map((r) => r.assessCalls)),
      avgMs: mean(rows.map((r) => (pick === 'fixed' ? r.fixedMs : r.agenticMs))),
      avgContextTokens: mean(pick === 'fixed' ? fixedTokens : agenticTokens),
    }
  }

  return { rows, fixed: summarize('fixed'), agentic: summarize('agentic') }
}
