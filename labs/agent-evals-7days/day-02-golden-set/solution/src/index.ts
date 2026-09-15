/**
 * evalkit CLI —— D2 版本：校验基准集、跑参考解体检、再出一份分集合的基线报告。
 *
 * 跑：
 *   MOCK=1 pnpm start                # 默认 k=5
 *   MOCK=1 pnpm start -- --k 10
 *   MOCK=1 pnpm start -- --seed 42   # 固定种子，结果完全可复现
 */

import { graderRegistry, runSuite } from './core/runner'
import { loadGoldenSet, splitSuite, validateSuite } from './core/suite'
import { verifySuite } from './core/reference'
import { createTarget } from './agent/target'
import type { SuiteReport, Task } from './core/types'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function line(label: string, report: SuiteReport, total: number): string {
  return `${label.padEnd(6)} ${String(total).padStart(2)} 条　pass@${report.k} ${pct(
    report.passAtKRate
  )}　pass^${report.k} ${pct(report.passHatKRate)}`
}

async function main(): Promise<void> {
  const k = arg('k', 5)
  const seed = arg('seed', 20260914)

  const golden = loadGoldenSet()
  console.log(`基准集版本：${golden.version}　任务数：${golden.tasks.length}\n`)

  // ---- 第一步：校验基准集本身 ----
  const issues = validateSuite(golden.tasks, Object.keys(graderRegistry))
  if (issues.length > 0) {
    console.log('—— 基准集校验未通过 ——')
    for (const it of issues) console.log(`  ✗ ${it.taskId} [${it.field}] ${it.message}`)
    console.log('')
    process.exitCode = 1
    return
  }
  console.log('✓ 基准集校验通过：格式、金额、极性、配对、集合标签全部自洽\n')

  // ---- 第二步：参考解体检 ----
  const ref = await verifySuite(golden.tasks)
  for (const v of ref.verdicts) {
    if (!v.referencePassed || v.trivial) console.log(`  ✗ ${v.taskId}：${v.reason}`)
  }
  console.log(
    `✓ 参考解体检：${golden.tasks.length - ref.brokenCount}/${golden.tasks.length} 条可解，` +
      `${ref.trivialCount} 条无区分度\n`
  )

  // ---- 第三步：拿靶子跑基线，能力集与回归集分开报 ----
  const { capability, regression } = splitSuite(golden.tasks)
  const run = async (tasks: Task[]): Promise<SuiteReport> => runSuite(tasks, createTarget(seed), k)

  const all = await run(golden.tasks)
  const cap = await run(capability)
  const reg = await run(regression)

  console.log(`—— 基线报告（种子 ${seed}，每条跑 ${k} 次）——`)
  console.log(line('总分', all, golden.tasks.length))
  console.log(line('能力集', cap, capability.length))
  console.log(line('回归集', reg, regression.length))
  console.log('')
  console.log('回归集贴近 100%、能力集有爬坡空间，这才是两个可用的信号。')
  console.log('把它们加权平均成一个总分，就同时失去了报警能力和方向感。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
