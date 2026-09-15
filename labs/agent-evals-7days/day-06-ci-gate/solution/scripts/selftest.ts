/**
 * 自检：验回归门禁的九条不变量。
 *
 * 跑：MOCK=1 SELFTEST=1 pnpm selftest
 *
 * ⚠️ 三条防恒真断言在这里（第 1、3、4 条），它们互相咬合，少一条都不成立：
 *
 *   1. 可复现  —— 同一个种子两次快照的分数部分逐字相同。
 *      没有它，后面所有比较都没有意义（分数本身就不稳，谈何退化）。
 *   3. 抖动放行 —— 换种子的正常波动**不会**被判成退化。
 *      没有它，一条「永远拦截」的门禁也能通过第 4 条。
 *   4. 退化拦截 —— 被削弱过的靶子**必须**被拦下。
 *      没有它，一条「永远放行」的门禁也能通过第 3 条。
 *
 * 第 3 条和第 4 条必须同时存在，这是本天最重要的一条测试纪律：
 * **门禁的两种失效方向是相反的，只测一个方向等于没测。**
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSuite } from '../src/core/runner'
import { createTarget } from '../src/agent/target'
import { pickTasks, TASK_SET_VERSION } from '../src/tasks/day06'
import {
  buildBaseline,
  compareFingerprint,
  readBaseline,
  toScores,
  writeBaseline,
  type Baseline,
  type Fingerprint,
  type Scores,
} from '../src/ci/baseline'
import { exitCodeFor, gateFor, judge, runGate, type GateResult } from '../src/ci/gate'
import { weaken } from '../src/ci/weaken'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const TASKS = pickTasks('full')
const K = 5
const CONFIG = gateFor('full')

function fp(over: Partial<Fingerprint> = {}): Fingerprint {
  return {
    model: 'offline',
    promptVersion: 'refund-agent@1.3.0',
    taskSetVersion: TASK_SET_VERSION,
    evalkitVersion: 'evalkit@0.6.0',
    k: K,
    tier: 'full',
    ...over,
  }
}

async function scoresFor(seed: number, weakenRate = 0): Promise<Scores> {
  const base = createTarget(seed)
  const target = weakenRate > 0 ? weaken(base, weakenRate) : base
  return toScores(await runSuite(TASKS, target, K))
}

async function gateWith(baseline: Baseline, seed: number, weakenRate = 0): Promise<GateResult> {
  const scores = await scoresFor(seed, weakenRate)
  return runGate(
    { baseline, fingerprint: fp(), scores },
    async (rk) => {
      const base = createTarget(seed)
      const target = weakenRate > 0 ? weaken(base, weakenRate) : base
      return runSuite(TASKS, target, rk)
    },
    CONFIG
  )
}

async function main(): Promise<void> {
  // ---- 1. 防恒真：同一个种子跑两次，快照的分数部分逐字相同 ----
  // 加了两条非空守卫：一份空快照当然也「逐字相同」，那种通过毫无意义。
  const s1 = await scoresFor(20260914)
  const s2 = await scoresFor(20260914)
  check(
    '同一个种子两次快照的分数部分逐字相同（且不是一份空快照）',
    s1.tasks.length === TASKS.length &&
      s1.passRate > 0 &&
      JSON.stringify(s1) === JSON.stringify(s2),
    `tasks=${s1.tasks.length} passRate=${s1.passRate} equal=${JSON.stringify(s1) === JSON.stringify(s2)}`
  )

  const baseline = buildBaseline(await runSuite(TASKS, createTarget(20260914), K), fp(), 20260914)

  // ---- 2. 指纹不一致时拒绝比较 ----
  const mismatch = judge(
    { baseline, fingerprint: fp({ promptVersion: 'refund-agent@2.0.0' }), scores: s1 },
    CONFIG
  )
  check(
    '提示词版本变了就拒绝比较，判拦截而不是硬算差值',
    mismatch.verdict === 'block' && mismatch.reasons.some((r) => r.includes('不可比')),
    `verdict=${mismatch.verdict} reasons=${mismatch.reasons.join(' / ')}`
  )
  check(
    'compareFingerprint 能报出是哪个字段不一致',
    compareFingerprint(fp(), fp({ k: 9 })).join() === 'k',
    compareFingerprint(fp(), fp({ k: 9 })).join()
  )

  // ---- 3. 防恒真：正常抖动**不会**被判成退化 ----
  // 十二个不同种子跑同一个没被动过的 Agent，门禁一次都不许拦。
  // 这一条防的是「把阈值定得太紧」，那种门禁会天天误报，团队三周之内就学会跳过它。
  const jitterSeeds = [1000, 1097, 1291, 1582, 2164, 2261, 2746, 3134, 3619, 4201, 4492, 4783]
  const blocked: string[] = []
  for (const seed of jitterSeeds) {
    const r = await gateWith(baseline, seed)
    if (r.status === 'block') blocked.push(`${seed}(降${(r.drop * 100).toFixed(1)})`)
  }
  check(
    `${jitterSeeds.length} 个种子的正常抖动全部放行（没有一次被误判成退化）`,
    blocked.length === 0,
    `被拦下的：${blocked.join('、')}`
  )

  // ---- 4. 防恒真：真实退化**必须**被拦下 ----
  const degraded = await gateWith(baseline, 20260914, 0.35)
  check(
    '被削弱过的靶子被门禁拦下',
    degraded.status === 'block',
    `status=${degraded.status} drop=${degraded.drop}`
  )
  check(
    '拦截对应非零退出码（这是它能进流水线的前提）',
    exitCodeFor(degraded.status) === 1 && exitCodeFor('pass') === 0 && exitCodeFor('warn') === 0,
    `block=${exitCodeFor(degraded.status)}`
  )

  // ---- 5. 明显退化不该触发复跑 ----
  // 无条件复跑会把门禁的灵敏度乘以零：真退化重跑几次总能蒙混过去一次。
  check('明显退化直接拦截，不浪费一次复跑', degraded.reran === false, `reran=${degraded.reran}`)

  // ---- 6. 灰区会复跑，并且复跑收敛时判警告而不是拦截 ----
  // 基线记在一个偏幸运的种子上（0.975），对比一个偏倒霉的种子（0.85），
  // 单点差 12.5 个百分点落进灰区；加大样本之后差距收敛。
  const luckyBaseline = buildBaseline(await runSuite(TASKS, createTarget(4201), K), fp(), 4201)
  const gray = await gateWith(luckyBaseline, 1097)
  check(
    '灰区触发复跑，且复跑收敛后判警告（放行但记一笔）',
    gray.reran === true && gray.status === 'warn',
    `status=${gray.status} reran=${gray.reran} drop=${gray.drop} rerunDrop=${gray.rerunDrop}`
  )

  // ---- 7. 全绿变全红的任务要单独拦截，哪怕总分看起来没掉多少 ----
  const synthBase: Baseline = {
    schema: 1,
    fingerprint: fp(),
    seed: 1,
    recordedAt: '2026-09-14T00:00:00.000Z',
    scores: {
      passRate: 0.5,
      passAtKRate: 0.5,
      passHatKRate: 0.5,
      tasks: [
        { taskId: 'a', passRate: 1, passAtK: true, passHatK: true },
        { taskId: 'b', passRate: 0, passAtK: false, passHatK: false },
      ],
    },
  }
  const flipped: Scores = {
    passRate: 0.5,
    passAtKRate: 0.5,
    passHatKRate: 0.5,
    tasks: [
      { taskId: 'a', passRate: 0, passAtK: false, passHatK: false },
      { taskId: 'b', passRate: 1, passAtK: true, passHatK: true },
    ],
  }
  const flip = judge({ baseline: synthBase, fingerprint: fp(), scores: flipped }, CONFIG)
  check(
    '总分持平但有任务从每次都过变成每次都挂时，照样拦截',
    flip.verdict === 'block' && flip.collapsedTasks.join() === 'a',
    `verdict=${flip.verdict} collapsed=${flip.collapsedTasks.join()} drop=${flip.drop}`
  )

  // ---- 8. 快照能落盘并原样读回；读不到时返回 null 而不是抛异常 ----
  const dir = mkdtempSync(join(tmpdir(), 'evalkit-d06-'))
  try {
    const path = join(dir, 'baseline.json')
    writeBaseline(path, baseline)
    const back = readBaseline(path)
    check(
      '基线写盘之后原样读回（含环境指纹）',
      JSON.stringify(back) === JSON.stringify(baseline),
      back === null ? 'readBaseline 返回了 null' : '读回的内容与写入的不一致'
    )
    check(
      '基线不存在时返回 null，而不是抛异常（第一次接入流水线就是这个状态）',
      readBaseline(join(dir, 'nope.json')) === null
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
