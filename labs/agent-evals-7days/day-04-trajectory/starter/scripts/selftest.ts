/**
 * 自检：验 D4 轨迹评分器与模拟用户的八条不变量。
 *
 * 跑：MOCK=1 SELFTEST=1 pnpm selftest
 *
 * ⚠️ 写断言的纪律（本仓库为此栽过，D1 的自检里也写着）：
 * **盯用户可见的后果，不要盯内部变量的中间状态；一条恒真的断言比没有断言更危险。**
 *
 * 下面第 3 条和第 5 条是专门防恒真的，各自**双向**断言：
 *   第 3 条：循环检测在含「再查一次」的任务上必须触发，在普通任务上必须不触发。
 *            只断一边都是恒真的——一个永远返回 looped=true 的实现能过前半条，
 *            一个永远返回 false 的能过后半条。
 *   第 5 条：工具序列评分器在超窗以内的退款任务上，失败次数必须**既不是 0 也不是全部**。
 *            靶子跳过政策检查的概率是 0.25，所以它必然是个中间值；
 *            判成 0 说明评分器没生效，判成全部说明它在乱杀。
 */

import { graderRegistry, runTask, runTrial } from '../src/core/runner'
import { createTarget } from '../src/agent/target'
import {
  oneShotUser,
  persistentUser,
  runMultiTurn,
  withSimulatedUser,
} from '../src/agent/simulated-user'
import { buildWorld } from '../src/core/runner'
import {
  attributeFailures,
  callSignature,
  checkSequence,
  detectLoop,
  trajectoryGraders,
} from '../src/graders/trajectory'
import { day04Policies, day04Tasks, day04Users } from '../src/tasks/day04'
import type { Task, ToolCall } from '../src/core/types'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function taskById(id: string): Task {
  const t = day04Tasks.find((x) => x.id === id)
  if (!t) throw new Error(`任务 ${id} 不存在`)
  return t
}

const registry = { ...graderRegistry, ...trajectoryGraders(day04Policies) }

/** 统计一个任务跑 k 次里，某个评分器失败了几次。 */
async function failCount(task: Task, k: number, grader: string, seed: number): Promise<number> {
  const target = withSimulatedUser(createTarget(seed), day04Users)
  const report = await runTask(task, target, k, registry)
  let n = 0
  for (const gs of report.grades) {
    if (gs.some((g) => g.grader === grader && !g.passed)) n += 1
  }
  return n
}

async function main(): Promise<void> {
  // ---- 1. 调用签名按键排序，参数顺序不同不算两次调用 ----
  const a: ToolCall = {
    name: 'lookup_order',
    args: { orderId: 'A1', page: 1 },
    result: null,
    durationMs: 1,
  }
  const b: ToolCall = {
    name: 'lookup_order',
    args: { page: 1, orderId: 'A1' },
    result: null,
    durationMs: 1,
  }
  check(
    '参数键顺序不同的两次调用，签名相同',
    callSignature(a) === callSignature(b),
    `${callSignature(a)} vs ${callSignature(b)}`
  )

  // ---- 2. 顺序判定只判偏序，不判全序 ----
  const calls: ToolCall[] = [
    { name: 'check_policy', args: { orderId: 'A1' }, result: null, durationMs: 1 },
    { name: 'lookup_order', args: { orderId: 'A1' }, result: null, durationMs: 1 },
    { name: 'issue_refund', args: { orderId: 'A1' }, result: null, durationMs: 1 },
  ]
  const okSeq = checkSequence(calls, {
    requireBefore: [{ before: 'check_policy', after: 'issue_refund' }],
  })
  const badSeq = checkSequence(calls.slice(1), {
    requireBefore: [{ before: 'check_policy', after: 'issue_refund' }],
  })
  check(
    '前置关系只要求「之前出现过」，中间夹别的调用不算违规',
    okSeq.length === 0 && badSeq.length === 1 && badSeq[0].kind === 'missing-prerequisite',
    `ok=${okSeq.length} bad=${JSON.stringify(badSeq)}`
  )

  // ---- 3. 防恒真（双向）：循环检测该响的时候响，不该响的时候不响 ----
  const nagging = taskById('ev-102-nagging-user')
  const normal = taskById('ev-101-refund-in-window')
  const naggingLoops = await failCount(nagging, 12, 'loop', 4242)
  const normalLoops = await failCount(normal, 12, 'loop', 4242)
  check(
    '循环检测在「再查一次」任务上 12/12 触发，在普通任务上 0/12 触发',
    naggingLoops === 12 && normalLoops === 0,
    `nagging=${naggingLoops}/12 normal=${normalLoops}/12`
  )

  // ---- 4. 多轮才走得到的那条路径：单轮用户跑同一条任务，步数明显更少 ----
  const expired = taskById('ev-103-expired-multi-turn')
  const t0 = createTarget(777)
  const w1 = buildWorld(expired)
  const w2 = buildWorld(expired)
  const oneShot = await runMultiTurn(expired, t0, w1, oneShotUser)
  const multi = await runMultiTurn(expired, createTarget(777), w2, persistentUser)
  check(
    '同一条任务，会追问的用户比一问即走的用户跑出更长的轨迹',
    multi.turns > oneShot.turns &&
      multi.transcript.toolCalls.length > oneShot.transcript.toolCalls.length,
    `oneShot=${oneShot.turns}轮/${oneShot.transcript.toolCalls.length}步 multi=${multi.turns}轮/${multi.transcript.toolCalls.length}步`
  )

  // ---- 5. 防恒真：工具序列评分器抓到的「没查政策就退款」既不是 0 也不是全部 ----
  // 靶子跳过政策检查的概率是 0.25，40 次里应该落在中间。
  const K = 40
  const seqFails = await failCount(normal, K, 'sequence', 20260914)
  check(
    `工具序列评分器在 ${K} 次里抓到部分「没查政策就退款」（既不是 0 也不是全部）`,
    seqFails > 0 && seqFails < K,
    `${K} 次里 sequence 失败 ${seqFails} 次`
  )

  // ---- 6. 结果态看不见的那一块：纯查询任务 outcome 全绿而 sequence 全红 ----
  const infoOnly = taskById('ev-105-info-only-query')
  const infoTarget = withSimulatedUser(createTarget(31337), day04Users)
  const infoReport = await runTask(infoOnly, infoTarget, 10, registry)
  const outcomeOk = infoReport.grades.every(
    (gs) => gs.find((g) => g.grader === 'outcome')?.passed === true
  )
  const seqBad = infoReport.grades.every(
    (gs) => gs.find((g) => g.grader === 'sequence')?.passed === false
  )
  check(
    '乱开人工工单：结果态评分器 10/10 判通过，工具序列评分器 10/10 判失败',
    outcomeOk && seqBad,
    `outcome 全通过=${outcomeOk} sequence 全失败=${seqBad}`
  )

  // ---- 7. 预算评分器：超步数与超花费都要单独说清楚 ----
  const { trial } = await runTrial(
    nagging,
    withSimulatedUser(createTarget(5), day04Users),
    0,
    registry
  )
  const loopReport = detectLoop(trial.transcript.toolCalls, 2)
  check(
    '循环报告带出重复次数最多的那个签名，能直接定位到现场',
    loopReport.looped &&
      loopReport.maxRepeats >= 4 &&
      loopReport.signature.includes('lookup_order'),
    JSON.stringify(loopReport)
  )

  // ---- 8. 失败归因：分桶占比加起来是 1，且不把所有失败都扔进 outcome ----
  const suiteTarget = withSimulatedUser(createTarget(20260914), day04Users)
  const reports = []
  for (const task of day04Tasks) {
    reports.push(await runTask(task, suiteTarget, 20, registry))
  }
  const attribution = attributeFailures(reports)
  const sum = attribution.rows.reduce((s, r) => s + r.share, 0)
  const buckets = new Set(attribution.rows.map((r) => r.bucket))
  check(
    '失败归因：占比之和为 1，且失败分散在两个以上的桶里',
    attribution.failedTrials > 0 && Math.abs(sum - 1) < 1e-9 && buckets.size >= 2,
    `failed=${attribution.failedTrials} sum=${sum} buckets=${[...buckets].join(',')}`
  )

  console.log('')
  console.log('—— 归因表（种子 20260914，每任务 20 次）——')
  for (const row of attribution.rows) {
    console.log(`  ${row.bucket.padEnd(22)} ${String(row.count).padStart(3)} 次`)
  }

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
