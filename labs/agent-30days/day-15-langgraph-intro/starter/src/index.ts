import 'dotenv/config'
import { runGraph } from './graph'
import { SCENARIOS, shouldSplit } from './shared/decide'
import { PATTERNS, analyzeShape, renderPattern } from './shared/patterns'
import { preview } from './shared/state'

const results: boolean[] = []

// 四项自检的标题与失败提示，提示对应 starter 里的四个练习点
const ITEMS: [string, string][] = [
  ['模式结构图', 'analyzeShape 还没实现：要分别数条件出边、无条件出边、无条件入边和回边（练习 1）'],
  ['该不该拆的判据', 'shouldSplit 还在无脑返回「拆」：三条判据一条都没命中时必须判不拆（练习 2）'],
  ['三节点图跑通', '图里还缺 handle 节点，链路只有 intake → respond，工作区没有做完的活（练习 3）'],
  [
    '状态在节点之间流动',
    'runGraph 还在用 invoke，只拿得到最终态，看不到每个节点写了什么（练习 4）',
  ],
]

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/4] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

/** 五种模式的期望形状。Critic 与 Swarm 的四个布尔值完全一样——这不是 bug，见下面的注释。 */
const EXPECTED: Record<string, string> = {
  router: '分叉',
  'planner-executor': '扇出+汇合',
  critic: '分叉+回边',
  swarm: '分叉+回边',
  blackboard: '扇出+汇合+回边',
}

const LABELS = { branch: '分叉', fanOut: '扇出', join: '汇合', backEdge: '回边' } as const

function shapeKey(id: string): string {
  const pattern = PATTERNS.find((p) => p.id === id)
  if (!pattern) return '(缺这个模式)'
  const shape = analyzeShape(pattern)
  return (
    (['branch', 'fanOut', 'join', 'backEdge'] as const)
      .filter((k) => shape[k])
      .map((k) => LABELS[k])
      .join('+') || '直线'
  )
}

async function selfTest(): Promise<number> {
  // ---- 1. 五种模式的结构图，以及形状判定 ----
  console.log('\n五种协作模式的结构（虚线是条件边，运行时只走一条）：\n')
  for (const pattern of PATTERNS) console.log(`${renderPattern(pattern)}\n`)
  const actual = Object.keys(EXPECTED).map(shapeKey)
  const ok1 = Object.values(EXPECTED).every((want, i) => want === actual[i])
  check(1, ok1, `五种模式的形状依次是 ${actual.join('、')}`)
  console.log(
    '  注：Critic 与 Swarm 的四个布尔值一样，区别在「回边由谁决定」——' +
      'Critic 是固定的评审节点在决定，Swarm 是当前这位自己决定交给谁。形状分不开的地方，判据要用人话补上。'
  )

  // ---- 2. 该不该拆：两个该拆、两个不该拆 ----
  const want = [false, true, true, true]
  const verdicts = SCENARIOS.map(shouldSplit)
  const ok2 = verdicts.every((v, i) => v.split === want[i])
  for (const [i, verdict] of verdicts.entries()) {
    console.log(`  ${verdict.split ? '拆' : '不拆'}｜${SCENARIOS[i].name} → ${verdict.reasons[0]}`)
  }
  check(
    2,
    ok2,
    `${SCENARIOS.length} 个场景判对 ${verdicts.filter((v, i) => v.split === want[i]).length} 个`
  )

  // ---- 3. 三节点图跑通，并且回复随输入变化 ----
  const shipping = await runGraph('我的订单 SO20260901 到哪了')
  const refund = await runGraph('订单 SO20260901 我想退款')
  const doneCount = shipping.final.workspace.filter((t) => t.status === 'done').length
  const answer = shipping.final.messages.at(-1)
  const answerText = answer && typeof answer.content === 'string' ? answer.content : ''
  const refundLast = refund.final.messages.at(-1)
  const refundText = refundLast && typeof refundLast.content === 'string' ? refundLast.content : ''
  const ok3 =
    doneCount === 1 &&
    answer?.role === 'assistant' &&
    answerText.includes('SO20260901') &&
    refundText !== answerText
  console.log(`  物流问句 → ${answerText}`)
  console.log(`  退款问句 → ${refundText}`)
  check(
    3,
    ok3,
    `工作区里做完 ${doneCount} 件，末条消息是 ${answer?.role ?? '(空)'}，两个问句的回复${refundText === answerText ? '一样' : '不同'}`
  )

  // ---- 4. 状态流动：逐节点看见谁写了哪几个字段 ----
  console.log('\n  一次执行的状态流动：')
  for (const step of shipping.trace) {
    console.log(`    ${step.node.padEnd(8)} 写入 [${step.changed.join(', ')}] ${step.detail}`)
  }
  const path = shipping.trace.map((s) => s.node).join(' → ')
  const wroteRoute = shipping.trace.some((s) => s.changed.includes('route'))
  const ok4 = path === 'intake → handle → respond' && !wroteRoute
  check(
    4,
    ok4,
    `路径 ${path || '(没记到任何一步)'}，route 字段${wroteRoute ? '被提前写了' : '按约定留给 D16'}`
  )

  console.log(`\n最终状态：${shipping.final.messages.map(preview).join(' | ')}`)
  const passed = results.filter(Boolean).length
  console.log(`\n自检结果：${passed}/${results.length} 项通过`)
  return passed === results.length ? 0 : 1
}

async function demo(): Promise<void> {
  for (const pattern of PATTERNS) console.log(`${renderPattern(pattern)}\n`)
  for (const scenario of SCENARIOS) {
    const verdict = shouldSplit(scenario)
    console.log(
      `${verdict.split ? '拆' : '不拆'}｜${scenario.name} → ${verdict.reasons.join('；')}`
    )
  }
  const question = process.argv[2] ?? '我的订单 SO20260901 到哪了'
  const { trace, final } = await runGraph(question)
  console.log(`\n问：${question}`)
  for (const step of trace)
    console.log(`  ${step.node} 写入 [${step.changed.join(', ')}] ${step.detail}`)
  const last = final.messages.at(-1)
  console.log(`答：${last && typeof last.content === 'string' ? last.content : '(空)'}`)
}

const isSelfTest = process.env.SELFTEST === '1'
const exitCode = isSelfTest ? await selfTest() : (await demo(), 0)
process.exit(exitCode)
