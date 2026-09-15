/**
 * 从链路数据聚合出面板：**按任务维度**的成本、延迟与失败率。
 *
 * 这一节最容易被写成「把 runner 里已经有的数字换个地方打印一遍」。不是。
 * 区别在于：runner 的数字来自它自己的内存变量，而这里的数字**只从 span 里来**。
 * 也就是说，如果埋点埋漏了一个字段，面板上就一定看得出来 ——
 * 这正是线上的处境：线上没有 runner，只有一堆 span。
 */

import { GEN_AI, GEN_AI_OPERATION } from './semconv'
import { durationMs, groupByTrace, type Span } from './tracer'

/**
 * 计价表（每千 token 多少分）。
 *
 * ⚠️ 它必须与你网关的价目表对齐。写死在代码里是一个**已知的技术债**：
 * 厂商调价那天，你的历史成本面板会被一次性改写。真正稳的做法是把单价
 * 连同 span 一起落盘（按当时的价算一次、存下来），这里为了不引第二份配置先简化。
 */
export const PRICE_PER_1K_CENTS = {
  input: 0.3,
  output: 1.5,
} as const

export interface TaskRow {
  taskId: string
  trials: number
  failures: number
  /** 失败率，0..1。来源是 gen_ai.evaluation.score.label，不是 HTTP 状态码。 */
  failureRate: number
  costCents: number
  p50Ms: number
  p95Ms: number
  toolCalls: number
}

export interface Panel {
  traces: number
  rows: TaskRow[]
  totalCostCents: number
  totalToolCalls: number
  /** 采集到首块延迟的 chat span 数 / chat span 总数。 */
  ttfcCoverage: { withValue: number; total: number }
  /**
   * 平均首块延迟（秒）。**一条都没采到时是 null，不是 0。**
   * 0 会在面板上显示成「首块延迟 0 秒」，那是一个彻头彻尾的谎。
   */
  avgTtfcSeconds: number | null
}

function num(span: Span, key: string): number {
  const v = span.attributes[key]
  return typeof v === 'number' ? v : 0
}

function str(span: Span, key: string): string {
  const v = span.attributes[key]
  return typeof v === 'string' ? v : ''
}

/** 按约定的计价口径算一条 chat span 的钱。保留两位小数的分，便于对账。 */
export function spanCostCents(span: Span): number {
  // TODO 练习 4：按 token 用量与单价把一条 chat span 的花费算出来。
  //
  // 只有 chat span 有花费，工具 span 没有。
  // 从 gen_ai.usage.input_tokens / gen_ai.usage.output_tokens 两个属性读用量
  // （用上面的 num 辅助函数），按 PRICE_PER_1K_CENTS 折算，
  // 并 **保留两位小数的分**（Math.round(x * 100) / 100）—— 成本要能加总对账。
  //
  // 提醒：不要去读 runner 的 report.totalCostCents 抄一个数过来。
  // 这个面板存在的全部意义，就是它的每个数字都只从 span 里来。
  void span
  return 0
}

/** 分位数。样本少的时候 p95 没有统计意义，但面板上仍然要有这一列。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

export function aggregate(spans: Span[]): Panel {
  const traces = groupByTrace(spans)

  interface Bucket {
    latencies: number[]
    costCents: number
    trials: number
    failures: number
    toolCalls: number
  }
  const buckets = new Map<string, Bucket>()
  let totalCost = 0
  let totalTools = 0
  let ttfcWith = 0
  let ttfcTotal = 0
  let ttfcSum = 0

  for (const [, group] of traces) {
    const root = group.find((s) => s.parentSpanId === undefined)
    if (!root) continue
    const taskId = str(root, 'eval.task.id') || '(unknown)'

    let bucket = buckets.get(taskId)
    if (!bucket) {
      bucket = { latencies: [], costCents: 0, trials: 0, failures: 0, toolCalls: 0 }
      buckets.set(taskId, bucket)
    }

    bucket.trials += 1
    bucket.latencies.push(durationMs(root))
    // 失败的判据是评估标签，不是 span 的 HTTP 状态 ——
    // 一个「200 OK 但退错了钱」的试次，在 status 上看不出任何问题
    if (str(root, GEN_AI.EVALUATION_SCORE_LABEL) === 'fail') bucket.failures += 1

    for (const s of group) {
      if (s.operation === GEN_AI_OPERATION.CHAT) {
        const cost = spanCostCents(s)
        bucket.costCents += cost
        totalCost += cost
        ttfcTotal += 1
        const ttfc = s.attributes[GEN_AI.RESPONSE_TIME_TO_FIRST_CHUNK]
        if (typeof ttfc === 'number') {
          ttfcWith += 1
          ttfcSum += ttfc
        }
      }
      if (s.operation === GEN_AI_OPERATION.EXECUTE_TOOL) {
        bucket.toolCalls += 1
        totalTools += 1
      }
    }
  }

  const rows: TaskRow[] = [...buckets.entries()]
    .map(([taskId, b]) => ({
      taskId,
      trials: b.trials,
      failures: b.failures,
      failureRate: b.trials === 0 ? 0 : b.failures / b.trials,
      costCents: Math.round(b.costCents * 100) / 100,
      p50Ms: percentile(b.latencies, 50),
      p95Ms: percentile(b.latencies, 95),
      toolCalls: b.toolCalls,
    }))
    .sort((a, b) => b.failureRate - a.failureRate || a.taskId.localeCompare(b.taskId))

  return {
    traces: traces.size,
    rows,
    totalCostCents: Math.round(totalCost * 100) / 100,
    totalToolCalls: totalTools,
    ttfcCoverage: { withValue: ttfcWith, total: ttfcTotal },
    avgTtfcSeconds: ttfcWith === 0 ? null : ttfcSum / ttfcWith,
  }
}

/**
 * 尾部采样：**先判结果，再决定留不留。**
 *
 * 头部采样（一开始就掷骰子决定这条链路记不记）最省事，代价是
 * 一条 1% 命中的故障链路有 99% 的概率在它出问题之前就被丢掉了 ——
 * 于是线上最需要的那批样本，恰好是最容易被采样掉的那批。
 *
 * 这里的规则：**失败的一条不落，成功的按比例留。**
 * 用 traceId 的哈希取模而不是 Math.random()，同一条链路的判定才是稳定的。
 */
export function tailSample(spans: Span[], keepRatioOfPassing: number): Span[] {
  const traces = groupByTrace(spans)
  const kept: Span[] = []
  for (const [traceId, group] of traces) {
    const root = group.find((s) => s.parentSpanId === undefined)
    const failed = root ? root.status === 'error' : false
    if (failed || hashRatio(traceId) < keepRatioOfPassing) kept.push(...group)
  }
  return kept
}

/** traceId → [0,1) 的稳定哈希。 */
function hashRatio(traceId: string): number {
  let h = 2166136261
  for (let i = 0; i < traceId.length; i += 1) {
    h ^= traceId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}
