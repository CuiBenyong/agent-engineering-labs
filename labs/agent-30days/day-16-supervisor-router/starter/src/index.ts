import 'dotenv/config'
import { runGraph, type RunResult } from './graph'
import { CONFIDENCE_FLOOR, SUB_AGENTS } from './shared/routing'

const results: boolean[] = []

// 五项自检的标题与失败提示，提示逐条点名 starter 里对应的练习
const ITEMS: [string, string][] = [
  [
    '三条路由各命中一次',
    'supervisor 还在让模型用自然语言回答「该找谁」，正则捞不到路由名就静默落兜底（练习 1）',
  ],
  ['低置信度落 fallback', '置信度阈值没生效：模型自己都没把握的判断被原样采信了（练习 2）'],
  ['枚举外的路由名被挡下', '模型自造的部门名没被枚举挡住，图会跳到一个不存在的节点（练习 2）'],
  ['override 能强制改派', 'override 被忽略了：值班领导改派了，系统当没看见（练习 3）'],
  [
    '条件边真的按路由走',
    'selectRoute 无视状态里的 route、一律返回 order_lookup：路由算了但没人用（练习 4）',
  ],
]

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/5] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

/** 打印一次执行的路由结论与实际走到的子 Agent。 */
function report(question: string, run: RunResult, override?: string): string {
  const executed = run.trace.filter((s) => s.node !== 'supervisor').map((s) => s.node)
  const tag = override ? `（override=${override}）` : ''
  console.log(`  「${question}」${tag}`)
  console.log(`    route=${run.final.route}｜${run.final.routingReason}`)
  console.log(`    实际执行：${run.trace.map((s) => s.node).join(' → ')}`)
  return executed.join(',')
}

const Q_ORDER = '我的订单 SO20260901 到哪了'
const Q_REFUND = '订单 SO20260901 我想退款'
const Q_HELLO = '你好，在吗'
const Q_VAGUE = '上次那个事怎么样了'
const Q_COMPLAIN = '我要投诉你们'

async function selfTest(): Promise<number> {
  // ---- 1. 三条路由各命中一次 ----
  console.log('\n一、三个子 Agent 各接一单：\n')
  const order = await runGraph(Q_ORDER)
  const refund = await runGraph(Q_REFUND)
  const hello = await runGraph(Q_HELLO)
  const nodes = [report(Q_ORDER, order), report(Q_REFUND, refund), report(Q_HELLO, hello)]
  const hit = [...new Set(nodes)]
  const reasoned = [order, refund, hello].every((r) => (r.final.routingReason ?? '').length > 0)
  const ok1 = nodes.join(',') === SUB_AGENTS.join(',') && reasoned
  check(1, ok1, `依次接单的是 ${nodes.join('、')}，命中 ${hit.length}/3 个子 Agent`)

  // ---- 2. 低置信度落 fallback ----
  console.log('\n二、模型自己都没把握的一单：\n')
  const vague = await runGraph(Q_VAGUE)
  report(Q_VAGUE, vague)
  const vagueReason = vague.final.routingReason ?? ''
  const ok2 =
    vague.final.route === 'smalltalk' && vagueReason.startsWith('fallback:low-confidence(0.42)')
  check(
    2,
    ok2,
    `阈值 ${CONFIDENCE_FLOOR}｜最终走 ${vague.final.route}，理由 ${vagueReason.split('｜')[0]}`
  )

  // ---- 3. 枚举外的路由名 ----
  console.log('\n三、模型自造了一个不存在的部门：\n')
  const complain = await runGraph(Q_COMPLAIN)
  report(Q_COMPLAIN, complain)
  const complainReason = complain.final.routingReason ?? ''
  const ok3 =
    complain.final.route === 'smalltalk' &&
    complainReason.startsWith('fallback:unknown-route(complaint_handler)')
  check(3, ok3, `最终走 ${complain.final.route}，理由 ${complainReason.split('｜')[0]}`)

  // ---- 4. 人工 override ----
  console.log('\n四、值班领导改派：\n')
  const forced = await runGraph(Q_ORDER, 'refund_draft')
  const forcedNode = report(Q_ORDER, forced, 'refund_draft')
  const forcedReason = forced.final.routingReason ?? ''
  const ok4 =
    forced.final.route === 'refund_draft' &&
    forcedNode === 'refund_draft' &&
    forcedReason.startsWith('override:refund_draft') &&
    forcedReason.includes('order_lookup')
  check(
    4,
    ok4,
    `同一句话被改派到 ${forced.final.route}，理由里${forcedReason.includes('order_lookup') ? '保留了' : '丢掉了'}模型原判`
  )

  // ---- 5. 条件边真的按路由走，而且只走一条 ----
  console.log('\n五、条件边：一次只派一个人\n')
  const runs = [order, refund, hello, vague, complain, forced]
  const mismatched = runs.filter((r) => {
    const executed = r.trace.filter((s) => s.node !== 'supervisor').map((s) => s.node)
    return executed.length !== 1 || executed[0] !== r.final.route
  })
  const ok5 = mismatched.length === 0
  for (const r of runs) {
    const executed = r.trace.filter((s) => s.node !== 'supervisor').map((s) => s.node)
    console.log(
      `    route=${String(r.final.route).padEnd(13)} 实际跑了 ${executed.join('+') || '(没有子 Agent 执行)'}`
    )
  }
  check(
    5,
    ok5,
    `${runs.length} 次执行里有 ${runs.length - mismatched.length} 次「跑的正是判的那个」，且每次只跑一个子 Agent`
  )

  const passed = results.filter(Boolean).length
  console.log(`\n自检结果：${passed}/${results.length} 项通过`)
  return passed === results.length ? 0 : 1
}

async function demo(): Promise<void> {
  const question = process.argv[2] ?? Q_ORDER
  const override = process.env.OVERRIDE
  const { trace, final } = await runGraph(question, override)
  console.log(`\n问：${question}${override ? `（OVERRIDE=${override}）` : ''}`)
  for (const step of trace) {
    console.log(`  ${step.node.padEnd(13)} 写入 [${step.changed.join(', ')}] ${step.detail}`)
  }
  const last = final.messages.at(-1)
  console.log(`\n路由：${final.route}｜${final.routingReason}`)
  console.log(`答：${last && typeof last.content === 'string' ? last.content : '(空)'}`)
}

const isSelfTest = process.env.SELFTEST === '1'
const exitCode = isSelfTest ? await selfTest() : (await demo(), 0)
process.exit(exitCode)
