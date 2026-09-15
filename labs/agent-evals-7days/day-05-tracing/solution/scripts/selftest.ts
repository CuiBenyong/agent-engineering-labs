/**
 * 自检：验 D5 埋点层的十条不变量。
 *
 * 跑：MOCK=1 SELFTEST=1 pnpm selftest
 *
 * ⚠️ 三条专门防恒真的断言，写之前都做过变异检验（改坏一处 → 确认它真的会红）：
 *
 *   第 1 条（三层嵌套 + 父子 id 对得上）
 *       把 instrument.ts 里工具 span 的父亲从 chat 改成 root，树就塌成两层 —— 第 1 条红。
 *       而此时每条 span 的属性依然完全正确，任何按属性做的断言都照样全绿。
 *
 *   第 5 条（成本等于各 span token 按单价算出来的总和）
 *       它同时挡两种假绿：一是面板恒等于 0（断言要求严格大于 0），
 *       二是面板去抄 runner 的内存变量（断言要求它与独立重算的结果逐分相等）。
 *
 *   第 3 条（属性名护栏）
 *       只断言「用到的名字都合法」会恒真 —— 一个什么都没埋的实现零违规。
 *       所以它同时要求 REQUIRED_ATTRIBUTES 一个都不能少。
 */

import { runSuite } from '../src/core/runner'
import { createTarget } from '../src/agent/target'
import { day05Tasks } from '../src/tasks/day05'
import { Tracer, treeDepth, groupByTrace, type Span } from '../src/otel/tracer'
import { Instrumentation } from '../src/otel/instrument'
import { aggregate, tailSample, PRICE_PER_1K_CENTS } from '../src/otel/aggregate'
import {
  GEN_AI,
  GEN_AI_OPERATION,
  REQUIRED_ATTRIBUTES,
  isKnownAttribute,
  isKnownOperation,
} from '../src/otel/semconv'
import type { SuiteReport } from '../src/core/types'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function runTraced(seed: number, k: number): Promise<{ report: SuiteReport; spans: Span[] }> {
  const tracer = new Tracer({ idSeed: 1, now: () => 1_767_000_000_000 })
  const instrumentation = new Instrumentation(tracer, {
    providerName: 'openai-compatible-gateway',
    model: 'mock-model',
    temperature: 0,
    maxTokens: 1024,
  })
  const report = await runSuite(day05Tasks, instrumentation.wrap(createTarget(seed)), k)
  for (const t of report.tasks) {
    t.grades.forEach((grades, i) => instrumentation.attachEvaluation(t.taskId, i, grades))
  }
  return { report, spans: tracer.finished() }
}

async function main(): Promise<void> {
  const { report, spans } = await runTraced(20260914, 5)
  const traces = groupByTrace(spans)

  // ---- 1. 防恒真：链路树确实是三层，而且父子 id 真的对得上 ----
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  let depthOk = traces.size > 0
  let linkOk = true
  let toolUnderChat = 0
  for (const [, group] of traces) {
    if (treeDepth(group) !== 3) depthOk = false
    for (const s of group) {
      if (!s.parentSpanId) continue
      const parent = byId.get(s.parentSpanId)
      // 父 id 必须指向一条真实存在的 span，且同属一条链路
      if (!parent || parent.traceId !== s.traceId || parent.spanId === s.spanId) linkOk = false
      if (s.operation === GEN_AI_OPERATION.EXECUTE_TOOL) {
        if (parent?.operation !== GEN_AI_OPERATION.CHAT) linkOk = false
        else toolUnderChat += 1
      }
      if (
        s.operation === GEN_AI_OPERATION.CHAT &&
        parent?.operation !== GEN_AI_OPERATION.INVOKE_AGENT
      ) {
        linkOk = false
      }
    }
  }
  check(
    '链路树是 invoke_agent → chat → execute_tool 三层，且每个父 id 都指向真实的父 span',
    depthOk && linkOk && toolUnderChat > 0,
    `链路 ${traces.size} 条，深度全为 3：${depthOk}，父子关系正确：${linkOk}，工具 span ${toolUnderChat} 条`
  )

  // ---- 2. spanId 唯一，且每条链路恰好一个根 ----
  const uniqueIds = new Set(spans.map((s) => s.spanId)).size === spans.length
  let oneRootEach = true
  for (const [, group] of traces) {
    if (group.filter((s) => !s.parentSpanId).length !== 1) oneRootEach = false
  }
  check(
    'spanId 全局唯一，且每条链路恰好一个根 span',
    uniqueIds && oneRootEach,
    `唯一=${uniqueIds} 单根=${oneRootEach}`
  )

  // ---- 3. 属性名护栏：不许手写字符串，也不许少埋 ----
  const seen = new Set<string>()
  const bad: string[] = []
  for (const s of spans) {
    for (const key of Object.keys(s.attributes)) {
      if (key.startsWith('gen_ai.')) {
        seen.add(key)
        if (!isKnownAttribute(key)) bad.push(key)
      } else if (!key.startsWith('eval.')) {
        // 自定义属性必须在自己的命名空间里，不许裸奔
        bad.push(key)
      }
    }
  }
  const missing = REQUIRED_ATTRIBUTES.filter((a) => !seen.has(a))
  check(
    `全部 gen_ai.* 属性名都来自常量表，且必填的 ${REQUIRED_ATTRIBUTES.length} 个一个不少（本次检查了 ${seen.size} 个）`,
    bad.length === 0 && missing.length === 0 && seen.size > 0,
    `非法：${[...new Set(bad)].join(', ') || '无'}；缺失：${missing.join(', ') || '无'}`
  )

  // ---- 4. operation.name 只能是九个合法取值之一 ----
  const badOps = spans
    .map((s) => String(s.attributes[GEN_AI.OPERATION_NAME] ?? ''))
    .filter((v) => !isKnownOperation(v))
  check(
    'gen_ai.operation.name 全部落在九个合法取值内',
    badOps.length === 0 && spans.length > 0,
    badOps.join(', ')
  )

  // ---- 5. 防恒真：面板的花费 = 各 chat span 的 token 按单价算出来的总和 ----
  // 独立重算一遍，不复用 aggregate 的任何代码路径。
  let recomputed = 0
  for (const s of spans) {
    if (s.operation !== GEN_AI_OPERATION.CHAT) continue
    const input = Number(s.attributes[GEN_AI.USAGE_INPUT_TOKENS] ?? 0)
    const output = Number(s.attributes[GEN_AI.USAGE_OUTPUT_TOKENS] ?? 0)
    const cents =
      (input / 1000) * PRICE_PER_1K_CENTS.input + (output / 1000) * PRICE_PER_1K_CENTS.output
    recomputed += Math.round(cents * 100) / 100
  }
  recomputed = Math.round(recomputed * 100) / 100
  const panel = aggregate(spans)
  check(
    '面板的总花费等于各 span 的 token 按单价重算出来的总和，且严格大于 0',
    recomputed > 0 && Math.abs(panel.totalCostCents - recomputed) < 1e-9,
    `面板=${panel.totalCostCents} 重算=${recomputed}`
  )

  // ---- 6. 面板的花费还要对得上 runner 自己记的账 ----
  check(
    '面板的花费与 runner 记的总成本逐分相等（埋点没有漏记也没有重复记）',
    Math.abs(panel.totalCostCents - Math.round(report.totalCostCents * 100) / 100) < 0.02,
    `面板=${panel.totalCostCents} runner=${report.totalCostCents}`
  )

  // ---- 7. 埋点不改变被埋点对象的行为 ----
  const plain = await runSuite(day05Tasks, createTarget(777), 3)
  const traced = await runTraced(777, 3)
  check(
    '包上埋点前后，同一个种子跑出的轨迹逐字相同（埋点没有改变靶子的行为）',
    JSON.stringify(plain.tasks.map((t) => t.trials.map((x) => x.transcript))) ===
      JSON.stringify(traced.report.tasks.map((t) => t.trials.map((x) => x.transcript))),
    '包裹层改变了靶子的输出'
  )

  // ---- 8. 评估结论挂上了链路，且失败率对得上 ----
  const expectedFailures = report.tasks.map((t) => ({
    taskId: t.taskId,
    failures: t.passed.filter((p) => !p).length,
  }))
  const panelFailures = new Map(panel.rows.map((r) => [r.taskId, r.failures]))
  const failureMatch = expectedFailures.every((e) => panelFailures.get(e.taskId) === e.failures)
  const labelled = spans.filter(
    (s) => s.attributes[GEN_AI.EVALUATION_SCORE_LABEL] !== undefined
  ).length
  check(
    '评估分数已作为 gen_ai.evaluation.* 挂回根 span，面板失败率与 runner 的判定一致',
    failureMatch && labelled === traces.size && traces.size > 0,
    `带评估标签的 span ${labelled} 条 / 链路 ${traces.size} 条；失败数一致：${failureMatch}`
  )

  // ---- 9. 没采到首块延迟就报「未采集」，不许编一个 0 出来 ----
  check(
    '首块延迟一条都没采到时，面板给 null 而不是 0',
    panel.ttfcCoverage.withValue === 0 && panel.avgTtfcSeconds === null,
    `覆盖 ${panel.ttfcCoverage.withValue}/${panel.ttfcCoverage.total} 均值=${panel.avgTtfcSeconds}`
  )

  // ---- 10. 尾部采样必须保住全部失败链路 ----
  const kept = tailSample(spans, 0)
  const keptTraces = groupByTrace(kept)
  const failedTraces = [...traces.entries()].filter(([, g]) =>
    g.some((s) => !s.parentSpanId && s.status === 'error')
  )
  const allFailedKept = failedTraces.every(([id]) => keptTraces.has(id))
  check(
    '尾部采样在成功链路留存率为 0 时，仍然一条失败链路都不丢',
    failedTraces.length > 0 && allFailedKept && keptTraces.size === failedTraces.length,
    `失败链路 ${failedTraces.length} 条，采样后剩 ${keptTraces.size} 条`
  )

  console.log('')
  if (failures > 0) {
    console.error(`自检失败：${failures} 项`)
    process.exit(1)
  }
  console.log('自检全部通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
