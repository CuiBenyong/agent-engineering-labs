/**
 * 自检：验套件体检器的八条不变量。
 *
 * 跑：MOCK=1 pnpm selftest
 *
 * ⚠️ 这一天的自检有个特别之处：**被测对象是评估系统自己**。
 * 所以几乎每条断言都是**双向**的——既要验「该报的报了」，也要验「不该报的没报」。
 * 只验一个方向是恒真陷阱：一个永远报警的检测器能通过前者，
 * 一个永远不报警的检测器能通过后者。
 *
 * 第 4 条尤其重要：它守的是写这个文件时真实踩过的坑——
 * 分布退化成一个点时，「基线落在最高端」恒成立，检测器会对每个稳定套件报警。
 */

import { graderRegistry, runSuite } from '../src/core/runner'
import { createTarget } from '../src/agent/target'
import { correctAmountGrader, strictAmountGrader } from '../src/graders/defective'
import {
  buildReadingList,
  checkSuiteHealth,
  detectGradingDefect,
  detectUnrepresentativeBaseline,
} from '../src/health/suite-health'
import { renderReport } from '../src/health/report'
import { day07Tasks } from '../src/tasks/day07'
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

async function main(): Promise<void> {
  graderRegistry['strict-amount'] = strictAmountGrader
  graderRegistry['correct-amount'] = correctAmountGrader

  const k = 5
  const history: SuiteReport[] = []
  for (let r = 0; r < 3; r += 1) {
    history.push(await runSuite(day07Tasks, createTarget(9000 + r * 101), k))
  }
  const last = history[history.length - 1]
  const issues = checkSuiteHealth({ history, tasks: day07Tasks })
  const kinds = (id: string): string[] => issues.filter((i) => i.taskId === id).map((i) => i.kind)

  // ---- 1. 饱和检测：双向 ----
  // 稳定满分的要检出；会抖的不能检出，否则整个套件都会被标成饱和
  const saturatedHit = kinds('ev-702-saturated').includes('saturated')
  const flakyHit = kinds('ev-706-flaky').includes('saturated')
  check(
    '饱和检测：稳定满分的被检出，会抖的没有被误报',
    saturatedHit && !flakyHit,
    `saturated=${saturatedHit} flaky误报=${flakyHit}`
  )

  // ---- 2. 长期零分检测：双向 ----
  const brokenHit = kinds('ev-703-broken').includes('always-failing')
  const normalHit = kinds('ev-701-normal').includes('always-failing')
  check(
    '长期零分检测：坏任务被检出，正常任务没有被误报',
    brokenHit && !normalHit,
    `broken=${brokenHit} normal误报=${normalHit}`
  )

  // ---- 3. 判分缺陷检测：双向 ----
  // 这是全天最有说服力的一条：同一个 Agent、同一件事，
  // 只因为判分那三行不同，一个 0 分一个满分
  const defect = last.tasks.find((t) => t.taskId === 'ev-704-grading-defect')
  const fixed = last.tasks.find((t) => t.taskId === 'ev-705-grading-fixed')
  const defectPass = defect?.passed.filter(Boolean).length ?? -1
  const fixedPass = fixed?.passed.filter(Boolean).length ?? -1
  check(
    '判分缺陷的代价：严格相等比较 0 分，整数域比较满分（退款金额完全一样）',
    defectPass === 0 && fixedPass === k,
    `strict=${defectPass}/${k} correct=${fixedPass}/${k}`
  )
  check(
    '判分缺陷被检测器认出，而修好的那条没有被误报',
    kinds('ev-704-grading-defect').includes('grading-defect') &&
      !kinds('ev-705-grading-fixed').includes('grading-defect'),
    `defect=${kinds('ev-704-grading-defect')} fixed=${kinds('ev-705-grading-fixed')}`
  )

  // ---- 4. 防恒真：分布退化时不许报基线问题 ----
  // 所有运行分数都一样时，基线必然同时是最高和最低。
  // 这时候报「基线落在最高端」是恒真的废话，会让整份报告失去可信度。
  const flat = [0.6, 0.6, 0.6, 0.6, 0.6, 0.6]
  const flatIssues = detectUnrepresentativeBaseline(0.6, flat)
  check(
    '分布退化（所有运行同分）时，基线代表性检测保持沉默',
    flatIssues.length === 0,
    `报了 ${flatIssues.length} 条：${flatIssues[0]?.detail ?? ''}`
  )

  // ---- 5. 另一个方向：真实分布 + 极值基线，必须报 ----
  const spread = [0.55, 0.6, 0.6, 0.65, 0.7, 0.75]
  const hiIssues = detectUnrepresentativeBaseline(0.75, spread)
  const midIssues = detectUnrepresentativeBaseline(0.62, spread)
  check(
    '基线记在分布最高端要报，记在中间不报',
    hiIssues.length === 1 && midIssues.length === 0,
    `hi=${hiIssues.length} mid=${midIssues.length}`
  )

  // ---- 6. 同一个问题不刷屏 ----
  // k 次试次会给出 k 条一样的理由，按任务去重后应该只剩一条
  const defectIssues = detectGradingDefect(last).filter((i) => i.taskId === 'ev-704-grading-defect')
  check(
    '同一条任务的判分缺陷只报一次，不按试次刷屏',
    defectIssues.length === 1,
    `报了 ${defectIssues.length} 条`
  )

  // ---- 7. 读轨迹清单必须同时含失败与通过样本 ----
  // 只看失败会形成「它什么都做不对」的错觉，
  // 只看通过则完全发现不了判据太松
  const list = buildReadingList(last)
  const hasFail = list.some((r) => r.why.includes('失败'))
  const hasPass = list.some((r) => r.why.includes('通过'))
  check(
    '读轨迹清单同时包含失败样本与通过样本',
    hasFail && hasPass && list.length > 0,
    `共 ${list.length} 条 fail=${hasFail} pass=${hasPass}`
  )

  // ---- 8. 报告里必须带环境指纹 ----
  // 没有指纹的报告下周就没法和今天比，那它只是一次性的自我安慰
  const text = renderReport({
    report: last,
    issues,
    readingList: list,
    fingerprint: { 任务集版本: 'day07-v1', 每任务试次: k },
  })
  check(
    '报告包含环境指纹与两个概率指标',
    text.includes('环境指纹') && text.includes('day07-v1') && text.includes('pass^'),
    '缺少指纹或指标'
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
