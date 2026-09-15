/**
 * 汇总与落盘。本天新增。
 *
 * 四类指标的分工（为什么一条不够，正文那节展开，这里只写口径）：
 *
 *   通过率      做没做到。**只有它是结论**，另外三条都是解释
 *   平均轮数    做到得顺不顺。同样全过，四轮做完和八轮做完是两个东西
 *   token 消耗  这次评估花了多少输入输出，成本那一列由它乘单价得来
 *   缓存命中率  输入里有多少是命中缓存的。它解释「为什么 token 多了钱没多」
 *
 * 关于缓存命中率有一条必须守住的纪律：**cachedTokens 全是 0 有两种可能**——
 * 真的一次没命中，或者你所用的网关根本不回传这个字段。代码分不清这两件事，
 * 所以报告里把它标成「不可用」并写清原因，绝不打印一个看起来很确定的 0.0%。
 * 猜一个命中规则来倒推，比不报这个数糟得多。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { costOf, formatCost, isPriced, type Rates } from './cost.js'

export const EVALS_DIR = path.resolve(process.cwd(), 'work/evals')

export interface CheckResult {
  label: string
  ok: boolean
}

export interface Attempt {
  taskId: string
  title: string
  difficulty: number
  variantId: string
  /** 同一题的第几次重复，从 1 起 */
  attempt: number
  passed: boolean
  checks: CheckResult[]
  rounds: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
  /** 直接来自 RenderSummary.tools，本天不另造一套工具统计 */
  toolCalls: number
  toolFailures: number
  truncated: number
  elapsedMs: number
}

export interface Summary {
  attempts: number
  passed: number
  /** 0–1 */
  passRate: number
  avgRounds: number
  avgTotalTokens: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
  /** 命中率；不可用时是 null，绝不用 0 顶替 */
  cacheHitRate: number | null
  cacheNote: string
  toolCalls: number
  avgElapsedMs: number
  cost: number | null
}

export interface VariantReport {
  variantId: string
  label: string
  attempts: Attempt[]
  summary: Summary
}

export interface RunReport {
  runId: string
  startedAt: string
  mode: 'mock' | 'gateway'
  model: string
  repeat: number
  rates: Rates
  variants: VariantReport[]
}

export function summarize(attempts: Attempt[], rates: Rates): Summary {
  const n = Math.max(1, attempts.length)
  const sum = (pick: (a: Attempt) => number): number => attempts.reduce((t, a) => t + pick(a), 0)
  const promptTokens = sum((a) => a.promptTokens)
  const cachedTokens = sum((a) => a.cachedTokens)
  const completionTokens = sum((a) => a.completionTokens)
  const usage = { promptTokens, completionTokens, cachedTokens }

  // 命中率的分母是输入 token，不是总 token：缓存只对输入生效，
  // 拿总量当分母会得到一个永远偏小、而且随输出长短乱晃的数
  const known = cachedTokens > 0
  return {
    attempts: attempts.length,
    passed: attempts.filter((a) => a.passed).length,
    passRate: attempts.filter((a) => a.passed).length / n,
    avgRounds: sum((a) => a.rounds) / n,
    avgTotalTokens: sum((a) => a.totalTokens) / n,
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: sum((a) => a.totalTokens),
    cacheHitRate: known && promptTokens > 0 ? cachedTokens / promptTokens : null,
    cacheNote: known
      ? '命中率 = 命中缓存的输入 token ÷ 输入 token'
      : '不可用：cachedTokens 全是 0。可能是真的一次没命中，也可能是这个网关不回传这个字段，代码分不出来——查网关文档',
    toolCalls: sum((a) => a.toolCalls),
    avgElapsedMs: sum((a) => a.elapsedMs) / n,
    cost: isPriced(rates) ? costOf(usage, rates) : null,
  }
}

/** 同一题重复多次时的抖动：极差除以均值。只有一次时是 null */
export function spread(values: number[]): number | null {
  if (values.length < 2) return null
  const avg = values.reduce((a, b) => a + b, 0) / values.length
  if (avg === 0) return 0
  return (Math.max(...values) - Math.min(...values)) / avg
}

export async function saveReport(report: RunReport): Promise<string> {
  await fs.mkdir(EVALS_DIR, { recursive: true })
  const file = path.join(EVALS_DIR, `${report.runId}.json`)
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}

export async function listReportIds(): Promise<string[]> {
  const entries = await fs.readdir(EVALS_DIR).catch(() => [] as string[])
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
    .reverse()
}

export async function loadReport(runId: string): Promise<RunReport | null> {
  const raw = await fs.readFile(path.join(EVALS_DIR, `${runId}.json`), 'utf8').catch(() => null)
  return raw === null ? null : (JSON.parse(raw) as RunReport)
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

/** 终端里的报告。每个变体一段，末尾是变体之间的对比 */
export function formatReport(report: RunReport): string[] {
  const lines: string[] = [
    `评估 ${report.runId}（${report.mode === 'mock' ? '离线剧本' : report.model}，每题跑 ${report.repeat} 次）`,
  ]
  for (const variant of report.variants) {
    const s = variant.summary
    lines.push(`  [${variant.variantId}] ${variant.label}`)
    for (const attempt of variant.attempts) {
      const bad = attempt.checks.filter((c) => !c.ok).map((c) => c.label)
      lines.push(
        `    ${attempt.passed ? '✔' : '✘'} ${attempt.taskId}（难度 ${attempt.difficulty}）` +
          ` ${attempt.rounds} 轮 · ${attempt.totalTokens} token · ${attempt.toolCalls} 次工具` +
          (bad.length > 0 ? ` · 没过：${bad.join('、')}` : '')
      )
    }
    lines.push(
      `    通过率 ${pct(s.passRate)}（${s.passed}/${s.attempts}）· 平均 ${s.avgRounds.toFixed(1)} 轮` +
        ` · 平均 ${Math.round(s.avgTotalTokens)} token · 合计 ${s.totalTokens} token`
    )
    lines.push(
      `    缓存命中率 ${s.cacheHitRate === null ? '不可用' : pct(s.cacheHitRate)}（${s.cacheNote}）`
    )
    lines.push(
      `    成本 ${formatCost({ promptTokens: s.promptTokens, completionTokens: s.completionTokens, cachedTokens: s.cachedTokens }, report.rates)}`
    )
  }
  const [base, other] = report.variants
  if (base && other) {
    const dPass = other.summary.passRate - base.summary.passRate
    const dTok = other.summary.totalTokens - base.summary.totalTokens
    lines.push(
      `  前后对比：通过率 ${dPass === 0 ? '一点没变' : `${dPass > 0 ? '+' : ''}${pct(dPass)}`}` +
        `，token ${dTok >= 0 ? '+' : ''}${dTok}（${pct(dTok / Math.max(1, base.summary.totalTokens))}）`
    )
  }
  return lines
}
