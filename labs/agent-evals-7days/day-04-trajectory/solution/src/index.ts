/**
 * evalkit CLI —— D4 版本：结果态之外再报轨迹指标与失败归因。
 *
 * 跑：
 *   MOCK=1 pnpm start
 *   MOCK=1 pnpm start -- --k 20 --seed 42
 */

import { graderRegistry, runSuite } from './core/runner'
import { createTarget } from './agent/target'
import { withSimulatedUser } from './agent/simulated-user'
import { attributeFailures, trajectoryGraders } from './graders/trajectory'
import { day04Policies, day04Tasks, day04Users } from './tasks/day04'

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
  const k = arg('k', 20)
  const seed = arg('seed', 20260914)
  const target = withSimulatedUser(createTarget(seed), day04Users)
  const registry = { ...graderRegistry, ...trajectoryGraders(day04Policies) }

  console.log(`靶子：${target.name}`)
  console.log(`任务数：${day04Tasks.length}　每个任务跑 ${k} 次　种子：${seed}\n`)

  const report = await runSuite(day04Tasks, target, k, registry)

  for (const t of report.tasks) {
    const steps = t.trials.map((x) => x.transcript.toolCalls.length)
    const avgSteps = steps.reduce((a, b) => a + b, 0) / Math.max(1, steps.length)
    const passCount = t.passed.filter(Boolean).length
    console.log(`${t.taskId}  [${t.polarity}]`)
    console.log(
      `  通过 ${passCount}/${k}　平均 ${avgSteps.toFixed(1)} 步　最多 ${Math.max(...steps)} 步`
    )
    // 按评分器分别统计失败次数，一眼看出是结果错了还是过程错了
    const byGrader = new Map<string, number>()
    for (const gs of t.grades) {
      for (const g of gs) {
        if (!g.passed) byGrader.set(g.grader, (byGrader.get(g.grader) ?? 0) + 1)
      }
    }
    if (byGrader.size > 0) {
      const line = [...byGrader.entries()].map(([g, n]) => `${g} ${n}`).join('　')
      console.log(`  失败分布：${line}`)
    }
    console.log('')
  }

  console.log('—— 汇总 ——')
  console.log(`pass@${k}  ：${pct(report.passAtKRate)}　pass^${k}：${pct(report.passHatKRate)}`)
  console.log(`总成本：${report.totalCostCents.toFixed(2)} 分`)
  console.log('')

  const attribution = attributeFailures(report.tasks)
  console.log(`—— 失败归因（${attribution.failedTrials}/${attribution.totalTrials} 次试次失败）——`)
  for (const row of attribution.rows) {
    console.log(`  ${row.bucket.padEnd(22)} ${String(row.count).padStart(3)} 次  ${pct(row.share)}`)
    console.log(`      例：${row.example}`)
  }
  console.log('')
  console.log('一个总成功率指导不了行动，一张归因表可以：占比最高的那一桶就是下一步要修的东西。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
