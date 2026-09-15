import { EVAL_SET, type EvalCase } from './corpus'
import { retrieve, type Mode } from './retrieve'
import type { Store } from './infra/store'

/**
 * recall@k：前 k 条里捞回了几成「必须召回」的 chunk。
 * 它评的是漏斗的上游——这一步漏掉的，后面重排得再准也救不回来。
 */
export function recallAt(ranked: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 1
  const top = new Set(ranked.slice(0, k))
  return gold.filter((id) => top.has(id)).length / gold.length
}

/**
 * MRR（mean reciprocal rank）：第一条正确答案排在第几名的倒数。
 * 它和 recall 是互补的——recall 只问「在不在里面」，MRR 还问「排在多前面」。
 */
export function reciprocalRank(ranked: string[], gold: string[]): number {
  const index = ranked.findIndex((id) => gold.includes(id))
  return index === -1 ? 0 : 1 / (index + 1)
}

export interface EvalResult {
  mode: Mode
  recall5: number
  recall20: number
  mrr: number
  worst: Array<{ query: string; missed: string[] }>
}

export async function evaluate(
  store: Store,
  mode: Mode,
  cases: EvalCase[] = EVAL_SET
): Promise<EvalResult> {
  let recall5 = 0
  let recall20 = 0
  let mrr = 0
  const worst: Array<{ query: string; missed: string[] }> = []

  for (const item of cases) {
    const ranked = (await retrieve(store, item.query, mode)).map((chunk) => chunk.chunkId)
    const r5 = recallAt(ranked, item.gold, 5)
    recall5 += r5
    recall20 += recallAt(ranked, item.gold, 20)
    mrr += reciprocalRank(ranked, item.gold)
    // 平均值只告诉你好不好，漏了哪几条才告诉你下一步改什么
    if (r5 < 1) {
      const top5 = new Set(ranked.slice(0, 5))
      worst.push({ query: item.query, missed: item.gold.filter((id) => !top5.has(id)) })
    }
  }

  const n = cases.length
  return { mode, recall5: recall5 / n, recall20: recall20 / n, mrr: mrr / n, worst }
}
