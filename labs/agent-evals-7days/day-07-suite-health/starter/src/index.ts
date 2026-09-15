/**
 * evalkit CLI —— D7：给套件本身做体检，并产出最终报告。
 *
 * 跑：
 *   MOCK=1 pnpm start              # 完整体检
 *   MOCK=1 pnpm start -- --rounds 5
 */

import { graderRegistry, runSuite } from './core/runner'
import { createTarget } from './agent/target'
import { correctAmountGrader, strictAmountGrader } from './graders/defective'
import { checkSuiteHealth, buildReadingList } from './health/suite-health'
import { renderReport } from './health/report'
import { day07Tasks } from './tasks/day07'
import type { SuiteReport } from './core/types'

const SEMCONV_VERSION = '1.42.0'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

async function main(): Promise<void> {
  const rounds = arg('rounds', 3)
  const k = arg('k', 5)

  // 把 D7 的两个演示评分器挂进注册表
  graderRegistry['strict-amount'] = strictAmountGrader
  graderRegistry['correct-amount'] = correctAmountGrader

  // --- 多轮历史：饱和与长期零分都需要跨轮才看得出来 ---
  const history: SuiteReport[] = []
  for (let r = 0; r < rounds; r += 1) {
    history.push(await runSuite(day07Tasks, createTarget(9000 + r * 101), k))
  }
  const last = history[history.length - 1]

  // --- 基线代表性：同配置多跑几次，看基线落在分布的什么位置 ---
  const noiseRates: number[] = []
  for (let i = 0; i < 12; i += 1) {
    const r = await runSuite(day07Tasks, createTarget(70000 + i * 977), k)
    noiseRates.push(r.passHatKRate)
  }
  // 故意把基线记在最高的一次上，演示 D6 没覆盖到的那个坑
  const baselineRate = Math.max(...noiseRates)

  const issues = checkSuiteHealth({
    history,
    tasks: day07Tasks,
    // D2 的参考解体检会认定它无区分度；这里直接给出结论
    trivialTaskIds: [],
    baselineRate,
    noiseRates,
  })

  console.log(
    renderReport({
      report: last,
      issues,
      readingList: buildReadingList(last),
      fingerprint: {
        靶子: createTarget(0).name,
        任务集版本: 'day07-v1',
        语义约定版本: SEMCONV_VERSION,
        轮数: rounds,
        每任务试次: k,
      },
    })
  )

  console.log('')
  console.log('-- 判分缺陷的代价（同一个 Agent，同一件事，两个评分器）--')
  const defect = last.tasks.find((t) => t.taskId === 'ev-704-grading-defect')
  const fixed = last.tasks.find((t) => t.taskId === 'ev-705-grading-fixed')
  const rate = (n: number, d: number): string => `${((n / d) * 100).toFixed(0)}%`
  if (defect && fixed) {
    console.log(
      `  严格相等比较：${rate(defect.passed.filter(Boolean).length, k)}　` +
        `整数域比较：${rate(fixed.passed.filter(Boolean).length, k)}`
    )
    console.log('  退款金额一模一样。差距全部来自判分那三行代码。')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
