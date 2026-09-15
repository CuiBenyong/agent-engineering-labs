import 'dotenv/config'
import { runRequest } from './graph'
import { ALT_JUDGE_MODEL, CHAT_MODEL, resetUsage, setPromptVersion, usageOf } from './infra/model'
import {
  failureReport,
  GOLDEN,
  HUMAN_LABELS,
  passed,
  runGoldenSet,
  runOne,
  type CaseResult,
} from './shared/golden'
import { calibrate, judge, PASS_SCORE } from './shared/judge'
import { buildPanel, costOf, PRICE_IN, PRICE_OUT, pct, renderTree, usd } from './shared/observe'

const results: boolean[] = []

const ITEMS: [string, string][] = [
  ['被评估的系统能跑起来', '不依赖练习：它只确认图本身没坏'],
  ['golden set 15 条整批跑完并给出通过率', 'runGoldenSet 只跑了第一条（练习 1）'],
  ['judge 评分可复现 + 评分口径被版本化', 'judge 分数带随机扰动、口径也没记进记录（练习 2）'],
  ['改坏一条提示词，通过率下降并能定位到条', '先要有整批跑与可复现评分（练习 1、2）'],
  ['judge 的三种失效模式都能被观测到', 'judge 默认与被评者同源、校准也还没实现（练习 3）'],
  ['一条 trace 能还原完整调用树', 'span 没有父指针，树塌成了平铺列表（练习 4）'],
  [
    '成本面板的数字能被手算复核',
    '面板按调用摊成本（练习 5）；每请求超 5 次调用要先有整批跑（练习 1）',
  ],
]

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/7] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

const rate = (rs: CaseResult[]): string => `${passed(rs).length}/${rs.length}`

async function selfTest(): Promise<number> {
  // ---- 1. 被评估的系统本身 ----
  const smoke = await runRequest('smoke', 'SO20260901 现在什么状态')
  const ok1 =
    smoke.route === 'order_lookup' && smoke.output.includes('当前阶段') && smoke.spans.length > 3
  const d1 = `路由 ${smoke.route}，产出 ${smoke.output.length} 字，落了 ${smoke.spans.length} 个 span`
  check(1, ok1, d1)

  // ---- 2. 整批跑 golden set ----
  setPromptVersion('v2')
  resetUsage()
  const base = await runGoldenSet()
  const routeHit = base.filter((r) => r.routeOk).length
  console.log(`    逐条：${base.map((r) => `${r.caseId}:${r.score}`).join(' ')}`)
  const ok2 = base.length === 15 && passed(base).length === 15 && routeHit === 15
  const d2 = `${base.length} 条全部跑完，通过 ${rate(base)}，路由判对 ${routeHit}/${base.length}`
  check(2, ok2, d2)

  // ---- 3. 同一份产出评三次，分数必须一样；换一套评分提示词，分数不可比 ----
  const sample = base[0]
  const repeat = await Promise.all(
    [1, 2, 3].map(() => judge({ output: sample.output, checklist: sample.checklist }))
  )
  const stable = new Set(repeat.map((v) => `${v.score}|${v.reason}`)).size === 1
  const asV1 = { output: sample.output, checklist: sample.checklist, rubricVersion: 'v1' as const }
  const v1 = await judge(asV1)
  const mixed = buildPanel([sample, { ...sample, rubricVersion: 'v1' }])
  const scores = repeat.map((v) => v.score).join('/')
  console.log(`    ${sample.caseId} 连评三次：${scores} 分；换 v1 提示词：${v1.score} 分`)
  console.log(`    把两套口径的记录塞进同一个面板：${mixed.ok ? '居然算出来了' : mixed.reason}`)
  const ok3 = stable && v1.score !== sample.score && !mixed.ok
  const d3 = `三次同分=${stable}；v1 给 ${v1.score} 分而 v2 给 ${sample.score} 分，跨版本不可比；面板拒绝混算=${!mixed.ok}`
  check(3, ok3, d3)

  // ---- 4. 故意改坏一条提示词：把 compose 那句「针对评审意见补一句结论」删掉 ----
  setPromptVersion('broken')
  const broken = await runGoldenSet(GOLDEN, { promptVersion: 'broken' })
  const brokenFails = failureReport(broken)
  console.log(`    掉下去的是：\n      ${brokenFails.join('\n      ')}`)
  const ok4 = passed(broken).length < passed(base).length && brokenFails.length > 0
  const dropped = broken
    .filter((r) => !r.pass)
    .map((r) => r.caseId)
    .join('、')
  const d4 = `通过率从 ${rate(base)} 掉到 ${rate(broken)}，点名 ${dropped}`
  check(4, ok4, d4)

  // ---- 5. judge 的三种失效模式，全部在 broken 这批产出上量 ----
  // 5a 同源偏差：judge 换成与被评者同一个模型
  const sameModel = await runGoldenSet(GOLDEN, { judgeModel: CHAT_MODEL, promptVersion: 'broken' })
  // 5b 长度偏好：同一份产出灌 200 字无关内容，看两套提示词分别怎么反应
  const padded = `${sample.output}\n${'（补充说明：本次查询已同步至您的服务记录，如有疑问可随时回复本对话。）'.repeat(4)}`
  const padV1 = await judge({ ...asV1, output: padded })
  const padV2 = await judge({ output: padded, checklist: sample.checklist })
  // 5c 校准集：5 条人工标注，看 judge 的结论跟人对不对得上
  const labelled = (rs: CaseResult[]) =>
    rs
      .filter((r) => HUMAN_LABELS[r.caseId] !== undefined)
      .map((r) => ({ id: r.caseId, humanScore: HUMAN_LABELS[r.caseId], verdict: r.verdict }))
  const crossCal = calibrate(labelled(broken))
  const sameCal = calibrate(labelled(sameModel))
  console.log(`    同源 judge：${rate(sameModel)}；异源 judge：${rate(broken)}（同一批产出）`)
  const pad = padded.length - sample.output.length
  console.log(
    `    长度偏好：灌水 ${pad} 字后，v1 从 ${v1.score} 涨到 ${padV1.score} 分，v2 仍是 ${padV2.score} 分`
  )
  const gap = sameCal.disagreements.join('、') || '无'
  console.log(
    `    校准集 5 条：异源一致 ${crossCal.agreed}/5，同源一致 ${sameCal.agreed}/5（不一致：${gap}）`
  )
  const ok5 =
    passed(sameModel).length > passed(broken).length &&
    padV1.score > v1.score &&
    padV2.score === sample.score &&
    crossCal.agreed > sameCal.agreed
  const d5 = `同源虚高 ${rate(sameModel)} vs ${rate(broken)}；长答案在 v1 下加分、在 v2 下不加分；校准一致率 ${crossCal.agreed}/${crossCal.total} vs ${sameCal.agreed}/${sameCal.total}`
  check(5, ok5, d5)

  // ---- 6. 调用树 ----
  setPromptVersion('v2')
  const tree = await runOne(GOLDEN.find((g) => g.id === 'g03')!)
  console.log(`\n    g03 的调用树（${tree.input}）：`)
  for (const line of renderTree(tree.spans)) console.log(`      ${line}`)
  const nodes = tree.spans.filter((s) => s.kind === 'node')
  const executors = nodes.filter((s) => s.name === 'executor')
  const parallel = executors.some((a) =>
    executors.some((b) => a.id !== b.id && a.startMs < b.endMs && b.startMs < a.endMs)
  )
  const modelUnderNode = tree.spans
    .filter((s) => s.kind === 'model')
    .every((s) => nodes.some((n) => n.id === s.parentId))
  const redo = nodes.filter((s) => s.name === 'critic').some((s) => s.attrs.outcome === 'redo')
  const ok6 =
    tree.spans[0].kind === 'request' &&
    nodes.some((s) => s.name === 'supervisor' && s.attrs.route === 'refund_draft') &&
    executors.length === 4 &&
    parallel &&
    redo &&
    modelUnderNode
  const d6 = `${tree.spans.length} 个 span 还原成一棵树：路由→拆 3 件→${executors.length} 次执行（含 1 次 Critic 打回后的重跑）→汇总；并行可见=${parallel}；模型调用都挂在所属节点下=${modelUnderNode}`
  check(6, ok6, d6)

  // ---- 7. 成本面板 ----
  const built = buildPanel(base)
  if (!built.ok) return fail(7, built.reason)
  const p = built.panel
  const ju = usageOf('judge')
  const say = (line: string): void => console.log(`      ${line}`)
  console.log(
    `\n    面板（${p.requests} 次请求，评分口径 ${p.requests > 0 ? base[0].rubricVersion : ''}/${base[0].judgeModel}）`
  )
  say(
    `质量：通过率 ${pct(p.passRate)}｜路由准确率 ${pct(p.routeAccuracy)}｜降级率 ${pct(p.degradedRate)}｜兜底率 ${pct(p.fallbackRate)}`
  )
  say(`延迟：p50 ${p.p50.toFixed(1)}ms｜p95 ${p.p95.toFixed(1)}ms`)
  say(
    `调用：${p.modelCalls} 次模型调用 ÷ ${p.requests} 次请求 = 每请求 ${p.callsPerRequest.toFixed(1)} 次`
  )
  say('手算复核：')
  say(`  输入 ${p.promptTokens} tokens × $${PRICE_IN} / 1M = ${usd(p.costIn)}`)
  say(`  输出 ${p.completionTokens} tokens × $${PRICE_OUT} / 1M = ${usd(p.costOut)}`)
  say(`  合计 ${usd(p.costTotal)} ÷ ${p.requests} 次请求 = ${usd(p.costPerRequest)} / 请求`)
  say(
    `  按调用摊则是 ${usd(p.costTotal)} ÷ ${p.modelCalls} 次 = ${usd(p.costPerCall)} / 调用，差 ${(p.costPerRequest / p.costPerCall).toFixed(1)} 倍`
  )
  say(`钱花在谁身上：${p.byIntent.map(([n, c, cost]) => `${n} ${c} 次 ${usd(cost)}`).join('｜')}`)
  say(
    `评估本身的开销（不进生产成本）：judge ${ju.calls} 次，${usd(costOf(ju.promptTokens, ju.completionTokens))}`
  )
  // 手算复核的判据：拿面板上印出来的两个整数，按价目表重算一遍，必须分毫不差
  const byHand = (p.promptTokens * PRICE_IN) / 1e6 + (p.completionTokens * PRICE_OUT) / 1e6
  const ok7 =
    byHand === p.costTotal &&
    Math.abs(p.costTotal / p.requests - p.costPerRequest) < 1e-12 &&
    p.callsPerRequest > 5 &&
    p.byIntent[0][0] === 'compose'
  const d7 = `手算 ${usd(byHand)} 与面板 ${usd(p.costTotal)} 分毫不差；每请求 ${p.callsPerRequest.toFixed(1)} 次调用，所以按请求算单价才有意义`
  check(7, ok7, d7)

  const ok = results.filter(Boolean).length
  console.log(`\n自检结果：${ok}/${results.length} 项通过`)
  return ok === results.length ? 0 : 1
}

function fail(n: number, reason: string): number {
  check(n, false, reason)
  return 1
}

async function demo(): Promise<void> {
  const item = GOLDEN.find((g) => g.input === process.argv[2]) ?? GOLDEN[2]
  const question = process.argv[2] ?? item.input
  const run = await runRequest('demo', question)
  const v = await judge({ output: run.output, checklist: item.checklist })
  console.log(
    `问：${question}\n路由：${run.route}（${run.routingReason}）\n\n答：\n${run.output}\n`
  )
  console.log('调用树：')
  for (const line of renderTree(run.spans)) console.log(`  ${line}`)
  const head = `\n评分：${v.score}/5（${v.judgeModel}，口径 ${v.rubricVersion}，低于 ${PASS_SCORE} 分算失败）`
  console.log(`${head}｜${v.reason}`)
  console.log(`judge 默认用 ${ALT_JUDGE_MODEL}，被评估的系统用 ${CHAT_MODEL}——刻意不同源`)
}

const exitCode = process.env.SELFTEST === '1' ? await selfTest() : (await demo(), 0)
process.exit(exitCode)
