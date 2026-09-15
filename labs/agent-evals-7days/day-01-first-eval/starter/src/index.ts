/**
 * evalkit CLI —— D1 版本：跑一个套件，打印两个概率指标。
 *
 * 跑：
 *   MOCK=1 pnpm start            # 默认 k=5
 *   MOCK=1 pnpm start -- --k 10  # 每个任务跑 10 次
 *   MOCK=1 pnpm start -- --seed 42   # 固定随机种子，结果完全可复现
 */

import { runSuite } from './core/runner'
import { createTarget } from './agent/target'
import { day01Tasks } from './tasks/day01'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

async function main(): Promise<void> {
  const k = arg('k', 5)
  const seed = arg('seed', 20260914)
  const target = createTarget(seed)

  console.log(`靶子：${target.name}`)
  console.log(`任务数：${day01Tasks.length}　每个任务跑 ${k} 次　种子：${seed}\n`)

  const report = await runSuite(day01Tasks, target, k)

  for (const t of report.tasks) {
    const marks = t.passed.map((p) => (p ? '✓' : '✗')).join(' ')
    console.log(`${t.taskId}  [${t.polarity}]`)
    console.log(`  ${k} 次结果：${marks}`)
    // 只打印第一条失败原因，够定位就行；全部原因在 report 里
    const firstFail = t.grades.flat().find((g) => !g.passed)
    if (firstFail) console.log(`  失败样例：${firstFail.reason}`)
    console.log('')
  }

  console.log('—— 汇总 ——')
  console.log(`pass@${k}  （至少成一次）：${pct(report.passAtKRate)}`)
  console.log(`pass^${k} （${k} 次全成）：${pct(report.passHatKRate)}`)
  console.log(
    `总成本：${report.totalCostCents.toFixed(2)} 分　总耗时：${report.totalDurationMs} ms`
  )
  console.log('')
  console.log('两个数字差得越远，说明这个 Agent 越不稳定。')
  console.log('只报 pass@k 的评估报告，等于把不稳定性藏了起来。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
