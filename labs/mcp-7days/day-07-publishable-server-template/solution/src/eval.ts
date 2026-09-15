// 工具评估的跑分器。它回答的问题只有一个：给定一句话，模型会不会选中该选的那个工具。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpToolDef } from './protocol.js'
import type { Selector } from './selector.js'

export type CaseKind = 'happy' | 'edge' | 'trap'

export interface EvalCase {
  id: string
  kind: CaseKind
  utterance: string
  /** null 表示这一条不该调用任何工具。别把 null 当成「随便」。 */
  expected: string | null
  why: string
}

export interface CaseResult {
  id: string
  kind: CaseKind
  expected: string | null
  actual: string | null
  pass: boolean
}

const here = path.dirname(fileURLToPath(import.meta.url))

export function loadCases(file = path.join(here, 'evals/cases.json')): EvalCase[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { cases: EvalCase[] }
  const cases = raw.cases
  // 三类缺一不可。只有正例的评估集会给你一个 100% 的假象：
  // 它测不出「不该调的时候调了」，而线上大多数投诉恰恰是这一种。
  for (const kind of ['happy', 'edge', 'trap'] as const) {
    if (!cases.some((c) => c.kind === kind)) throw new Error(`评估集缺少 ${kind} 类用例`)
  }
  const ids = new Set(cases.map((c) => c.id))
  if (ids.size !== cases.length) throw new Error('评估集里有重复的用例 id')
  return cases
}

/**
 * 断言只有一条，但两个方向都要判：
 * expected 是工具名时，选中它才算过；expected 是 null 时，**什么都不选**才算过。
 * 把 null 当成「随便都行」是最常见的写法错误，会让负例永远绿。
 */
export function judge(expected: string | null, actual: string | null): boolean {
  return expected === null ? actual === null : actual === expected
}

export async function runEval(
  selector: Selector,
  tools: McpToolDef[],
  cases: EvalCase[]
): Promise<CaseResult[]> {
  const results: CaseResult[] = []
  for (const item of cases) {
    let actual: string | null = null
    try {
      actual = await selector.select(item.utterance, tools)
    } catch {
      actual = null // 选择器自己炸了也算一次没选中，别让整份评估中断
    }
    results.push({
      id: item.id,
      kind: item.kind,
      expected: item.expected,
      actual,
      pass: judge(item.expected, actual),
    })
  }
  return results
}

export function summarize(
  results: CaseResult[]
): Record<CaseKind, { pass: number; total: number }> {
  const out = {
    happy: { pass: 0, total: 0 },
    edge: { pass: 0, total: 0 },
    trap: { pass: 0, total: 0 },
  }
  for (const r of results) {
    out[r.kind].total += 1
    if (r.pass) out[r.kind].pass += 1
  }
  return out
}
