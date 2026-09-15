/**
 * 自检：验 D2 基准集与参考解体检的八条不变量。
 *
 * 跑：MOCK=1 SELFTEST=1 pnpm selftest
 *
 * ⚠️ 写断言时的纪律（本仓库为此栽过）：**盯用户可见的后果，不要盯内部变量的中间状态**。
 * 下面第 3、6、8 条是专门用来防恒真的：
 *   第 3 条防「校验器恒绿」——它必须对一份写坏的基准集报出问题；
 *   第 6 条防「区分度检查恒绿」——它必须能认出一条谁都能过的任务；
 *   第 8 条防「反向用例白写」——靶子必须真的在反向任务上翻过车，
 *                                 否则前面所有关于双向测试的结论都是空话。
 */

import { graderRegistry, runSuite } from '../src/core/runner'
import { loadGoldenSet, pairKeyOf, setTagOf, splitSuite, validateSuite } from '../src/core/suite'
import { createAlwaysRefundTarget, verifySuite } from '../src/core/reference'
import { createTarget } from '../src/agent/target'
import type { Task } from '../src/core/types'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const graderNames = Object.keys(graderRegistry)

async function main(): Promise<void> {
  // ---- 1. 基准集加载得到 24 条任务 ----
  const golden = loadGoldenSet()
  const tasks: Task[] = golden.tasks ?? []
  check('基准集加载成功且恰好 24 条', tasks.length === 24, `实际 ${tasks.length} 条`)

  // ---- 2. 真实基准集校验零问题 ----
  const issues = validateSuite(tasks, graderNames)
  check(
    '真实基准集通过全部校验规则',
    issues.length === 0,
    issues.map((i) => `${i.taskId}/${i.field}:${i.message}`).join('; ')
  )

  // ---- 3. 防恒真：校验器必须对写坏的任务报错 ----
  // 造四种「跑得起来但语义是错的」的坏任务，校验器一条都不许放过。
  //
  // ⚠️ 这里断言的是「有没有报出那一条**具体**的问题」，而不是「问题数量大于零」。
  //    写成后者会恒真：单独校验一条任务时，跨任务的配对规则必然报「配对不是一正一反」，
  //    于是无论语义规则在不在，问题数都大于零。这个坑是做变异检验时才发现的。
  const base = tasks[0]
  const broken: Array<{ name: string; field: string; task: Task }> = [
    {
      name: '金额与订单对不上',
      field: 'expect.refunds',
      task: {
        ...base,
        id: 'ev-901-bad-amount',
        expect: { refunds: [{ orderId: base.seed.orders[0].id, amountCents: 1 }] },
      },
    },
    {
      name: '反向任务却期望退款',
      field: 'expect.refunds',
      task: { ...base, id: 'ev-902-bad-polarity', polarity: 'negative' },
    },
    {
      name: '引用了未注册的评分器',
      field: 'graders',
      task: { ...base, id: 'ev-903-bad-grader', graders: ['no-such-grader'] },
    },
    {
      name: 'prompt 提到的订单不在 seed 里',
      field: 'prompt',
      task: { ...base, id: 'ev-904-ghost-order', prompt: '订单 Z9999 帮我退款。' },
    },
  ]
  const missed = broken.filter(({ task, field }) => {
    const found = validateSuite([task], graderNames)
    return !found.some((i) => i.taskId === task.id && i.field === field)
  })
  check(
    '校验器能抓出四种写坏的任务，且报在正确的字段上（防恒绿）',
    missed.length === 0,
    `漏掉了：${missed.map((b) => b.name).join('、')}`
  )

  // ---- 4. 双向覆盖：12 对，每对一正一反 ----
  const pairs = new Map<string, Task[]>()
  for (const t of tasks) {
    const key = pairKeyOf(t) ?? '(无)'
    pairs.set(key, [...(pairs.get(key) ?? []), t])
  }
  const balanced = [...pairs.values()].every(
    (list) =>
      list.filter((t) => t.polarity === 'positive').length === 1 &&
      list.filter((t) => t.polarity === 'negative').length === 1
  )
  check(
    '12 对任务，每对恰好一正一反',
    pairs.size === 12 && balanced,
    `实际 ${pairs.size} 对，配平=${balanced}`
  )

  // ---- 5. 参考解在全部 24 条上通过（任务本身可解） ----
  const ref = await verifySuite(tasks)
  check(
    '参考解通过全部 24 条任务',
    ref.brokenCount === 0,
    ref.verdicts
      .filter((v) => !v.referencePassed)
      .slice(0, 3)
      .map((v) => `${v.taskId}: ${v.reason}`)
      .join('; ')
  )
  check('真实基准集里没有无区分度的任务', ref.trivialCount === 0, `${ref.trivialCount} 条`)

  // ---- 6. 防恒真：区分度检查必须能认出一条谁都能过的任务 ----
  // 订单号在 prompt 里但不在 seed 里 → 谁都查不到订单，谁都什么也不做，
  // 而期望恰好就是什么都别做。这条任务永远满分，却一个字的信息都没有。
  const trivialTask: Task = {
    id: 'ev-905-trivial',
    prompt: '订单 Z9999 帮我退款。',
    polarity: 'negative',
    seed: { orders: [{ id: 'Y1000', amountCents: 100, ageDays: 1, refunded: false }] },
    expect: { refunds: [] },
    graders: ['outcome'],
    tags: ['pair:p99-trivial', 'set:capability'],
  }
  const trivialReport = await verifySuite([trivialTask])
  check(
    '区分度检查认得出一条谁都能通过的任务（防恒绿）',
    trivialReport.trivialCount === 1,
    JSON.stringify(trivialReport.verdicts)
  )

  // ---- 7. 能力集与回归集不重叠、并集等于全集、且都非空 ----
  const { capability, regression } = splitSuite(tasks)
  const capIds = new Set(capability.map((t) => t.id))
  const overlap = regression.filter((t) => capIds.has(t.id)).length
  check(
    '能力集与回归集互不重叠、并起来正好是全集、且都非空',
    overlap === 0 &&
      capability.length + regression.length === tasks.length &&
      capability.length > 0 &&
      regression.length > 0,
    `能力集 ${capability.length}　回归集 ${regression.length}　重叠 ${overlap}`
  )

  // ---- 8. 防恒真：靶子必须真的在反向任务上翻车 ----
  // 这一条是整个「双向测试」论点的实证。如果靶子从不在反向任务上出错，
  // 那么 12 条反向任务就是白写的，前面七条断言全绿也证明不了任何东西。
  const negatives = tasks.filter((t) => t.polarity === 'negative')
  const negReport = await runSuite(negatives, createTarget(31337), 10)
  const flaky = negReport.tasks.filter((t) => !t.passHatK).length
  check(
    '靶子在反向任务上确实翻过车（反向用例不是白写的）',
    flaky > 0,
    `${negatives.length} 条反向任务在 10 次重复里一条都没失败`
  )

  // ---- 补充：见单就退的退化解必须挂在反向任务上 ----
  const alwaysReport = await runSuite(negatives, createAlwaysRefundTarget(), 1)
  check(
    '见单就退的退化解在反向任务上全挂',
    alwaysReport.passAtKRate === 0,
    `pass@1=${alwaysReport.passAtKRate}`
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
