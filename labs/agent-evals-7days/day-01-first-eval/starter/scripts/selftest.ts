/**
 * 自检：验 evalkit 内核的五条不变量。
 *
 * 跑：MOCK=1 SELFTEST=1 pnpm selftest
 *
 * ⚠️ 写断言时的纪律（本仓库为此栽过）：**盯用户可见的后果，不要盯内部变量的中间状态**。
 * 下面第 3 条和第 6 条是专门用来防恒真的——
 * 如果把靶子改成确定性的（去掉 rng），第 3 条会红；
 * 如果把缺陷 1 的概率改成 0，第 6 条会红。
 * 没有这两条，其余断言在一个「永远返回成功」的假靶子上也会全绿。
 */

import { runSuite, runTask, buildWorld, outcomeGrader } from '../src/core/runner'
import { createTarget } from '../src/agent/target'
import { day01Tasks } from '../src/tasks/day01'
import type { EvalTarget, Task, Trial } from '../src/core/types'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  // ---- 1. 试次之间不共享状态 ----
  const task = day01Tasks[0]
  const w1 = buildWorld(task)
  const w2 = buildWorld(task)
  w1.refunds.push({ orderId: 'X', amountCents: 1 })
  w1.orders['A1001'].refunded = true
  check(
    '每个试次拿到全新世界：改 w1 不影响 w2',
    w2.refunds.length === 0 && w2.orders['A1001'].refunded === false,
    `w2.refunds=${w2.refunds.length} refunded=${w2.orders['A1001'].refunded}`
  )

  // ---- 2. 同 seed 完全可复现 ----
  const a = await runSuite(day01Tasks, createTarget(42), 5)
  const b = await runSuite(day01Tasks, createTarget(42), 5)
  check(
    '同一个种子跑两次，每条试次的通过序列逐位相同',
    JSON.stringify(a.tasks.map((t) => t.passed)) === JSON.stringify(b.tasks.map((t) => t.passed)),
    `a=${JSON.stringify(a.tasks.map((t) => t.passed))} b=${JSON.stringify(b.tasks.map((t) => t.passed))}`
  )

  // ---- 3. 防恒真：不同 seed 必须真的产生不同结果 ----
  // 靶子如果是确定性的，这门课就没有存在的必要了。
  const seeds = [1, 7, 13, 99, 1234, 5678, 24680, 13579]
  const signatures = new Set<string>()
  for (const s of seeds) {
    const r = await runSuite(day01Tasks, createTarget(s), 5)
    signatures.add(JSON.stringify(r.tasks.map((t) => t.passed)))
  }
  check(
    '换种子会得到不同的通过序列（靶子确实是非确定性的）',
    signatures.size > 1,
    `${seeds.length} 个种子只产出了 ${signatures.size} 种结果`
  )

  // ---- 4. pass^k 永远不会高于 pass@k ----
  const r = await runSuite(day01Tasks, createTarget(2026), 8)
  check(
    'pass^k 不高于 pass@k',
    r.passHatKRate <= r.passAtKRate,
    `pass@k=${r.passAtKRate} pass^k=${r.passHatKRate}`
  )

  // ---- 5. 结果态优先：Agent 嘴上说退了，但库里没记录，必须判失败 ----
  const liar: EvalTarget = {
    name: 'liar',
    async run() {
      return {
        messages: [
          { role: 'assistant' as const, content: '已为订单 A1001 办理退款，金额 49.90 元。' },
        ],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 10,
        costCents: 0.1,
        durationMs: 1,
      }
    },
  }
  const liarReport = await runTask(task, liar, 3)
  check(
    '只在回复里声称退款、结果态没有记录的，一律判失败',
    liarReport.passAtK === false,
    `passAtK=${liarReport.passAtK}`
  )

  // ---- 6. 防恒真：超窗订单任务必须真的在抖 ----
  // ev-002 是 90 天前的订单，正确行为是拒退；靶子的缺陷 1 会让它偶尔退掉。
  // 跑足够多次之后，应该**既有通过也有失败**。全通过或全失败都说明缺陷没生效。
  const expired = day01Tasks.find((t) => t.id === 'ev-002-expired-order') as Task
  const many = await runTask(expired, createTarget(31337), 40)
  const passCount = many.passed.filter(Boolean).length
  check(
    '超窗订单任务在 40 次里既有通过也有失败（缺陷 1 确实在触发）',
    passCount > 0 && passCount < 40,
    `40 次里通过 ${passCount} 次`
  )

  // ---- 7. Agent 崩溃不被静默吞掉 ----
  const boom: EvalTarget = {
    name: 'boom',
    async run(): Promise<never> {
      throw new Error('模型网关 503')
    },
  }
  const boomReport = await runTask(task, boom, 2)
  // 练习 2 还没做时 trials 是空的，这里要报成一条清晰的失败而不是 TypeError，
  // 否则后面的断言全被一个崩溃掩盖掉。
  const boomTrial: Trial | undefined = boomReport.trials[0]
  check(
    'Agent 抛异常时，错误原因带进了试次和评分理由',
    boomTrial?.error === '模型网关 503' &&
      boomReport.grades[0]?.[0]?.reason.includes('模型网关 503') === true,
    boomTrial === undefined
      ? 'trials 是空的（练习 2 还没做？）'
      : `error=${boomTrial.error} reason=${boomReport.grades[0]?.[0]?.reason}`
  )

  // ---- 8. 未注册的评分器要报出来，不能当成通过 ----
  const badTask: Task = { ...task, id: 'bad', graders: ['nope'] }
  const badReport = await runTask(badTask, createTarget(1), 1)
  const badReason = badReport.grades[0]?.[0]?.reason
  check(
    '引用了未注册的评分器时判失败并说明原因',
    badReport.passed[0] === false && badReason?.includes('未注册') === true,
    badReason ?? 'grades 是空的（练习 2 还没做？）'
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
