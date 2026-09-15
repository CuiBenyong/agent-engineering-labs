/**
 * evalkit 门禁 CLI —— D6 版本。
 *
 * 三个动作：
 *   MOCK=1 pnpm start -- --record          记录基线（写进 work/baseline.json）
 *   MOCK=1 pnpm start                      跑门禁，退化时以非零退出码结束
 *   MOCK=1 pnpm start -- --noise 30        实测噪声区间，用来定阈值
 *
 * 常用开关：
 *   --tier smoke|full   冒烟档（每次提交跑）还是全量档（发版前跑）
 *   --k 5               每个任务跑几次
 *   --seed 20260914     随机种子
 *   --weaken 0.35       人为削弱靶子，用来验证门禁真的拦得住
 */

import { runSuite } from './core/runner'
import { createTarget } from './agent/target'
import { pickTasks, TASK_SET_VERSION } from './tasks/day06'
import {
  buildBaseline,
  readBaseline,
  toScores,
  writeBaseline,
  type Fingerprint,
} from './ci/baseline'
import { exitCodeFor, gateFor, runGate } from './ci/gate'
import { weaken } from './ci/weaken'

/** 提示词版本：提示词改一个字就要改它。 */
const PROMPT_VERSION = 'refund-agent@1.3.0'
/** 评估框架自身的版本：评分器改了也会让分数变。 */
const EVALKIT_VERSION = 'evalkit@0.6.0'

const BASELINE_PATH = 'work/baseline.json'

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

function str(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return process.argv[i + 1] ?? fallback
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

async function main(): Promise<void> {
  const tier: 'smoke' | 'full' = str('tier', 'full') === 'smoke' ? 'smoke' : 'full'
  const k = num('k', 5)
  const seed = num('seed', 20260914)
  const weakenRate = num('weaken', 0)
  const tasks = pickTasks(tier)

  const makeTarget = (): ReturnType<typeof createTarget> => {
    const base = createTarget(seed)
    return weakenRate > 0 ? weaken(base, weakenRate) : base
  }

  const fingerprint: Fingerprint = {
    model: process.env.LLM_MODEL ?? 'offline',
    promptVersion: PROMPT_VERSION,
    taskSetVersion: TASK_SET_VERSION,
    evalkitVersion: EVALKIT_VERSION,
    k,
    tier,
  }

  // ---- 噪声测量：只换种子，连跑 N 轮，看通过率的波动区间 ----
  if (has('noise')) {
    const rounds = num('noise', 30)
    const rates: number[] = []
    for (let i = 0; i < rounds; i += 1) {
      const r = await runSuite(tasks, createTarget(1000 + i * 97), k, undefined)
      rates.push(toScores(r).passRate)
    }
    const min = Math.min(...rates)
    const max = Math.max(...rates)
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length
    const maxDev = Math.max(...rates.map((r) => Math.abs(r - mean)))
    console.log(`噪声实测：${tier} 档 ${tasks.length} 条任务，k=${k}，${rounds} 个种子`)
    console.log(`  区间 ${min.toFixed(4)} – ${max.toFixed(4)}`)
    console.log(`  均值 ${mean.toFixed(4)}　最大单轮偏离均值 ${maxDev.toFixed(4)}`)
    console.log('')
    console.log('阈值就定在这个区间之外：警告线要略高于最大偏离，拦截线要明显更高。')
    const cfg = gateFor(tier)
    console.log(`当前 ${tier} 档配置：警告线 ${pct(cfg.warnDrop)}　拦截线 ${pct(cfg.blockDrop)}`)
    return
  }

  const report = await runSuite(tasks, makeTarget(), k, undefined)
  const scores = toScores(report)

  // 分档的依据是成本，所以每次都把成本摆出来——看不见成本就无从取舍
  const trials = tasks.length * k
  let toolCalls = 0
  for (const t of report.tasks)
    for (const tr of t.trials) toolCalls += tr.transcript.toolCalls.length
  console.log(
    `本次运行：${tier} 档 ${tasks.length} 条任务 × ${k} 次 = ${trials} 次试次，` +
      `${toolCalls} 次工具调用，成本 ${report.totalCostCents.toFixed(2)} 分`
  )

  // ---- 记录基线 ----
  if (has('record')) {
    const baseline = buildBaseline(report, fingerprint, seed)
    writeBaseline(BASELINE_PATH, baseline)
    console.log(`已记录基线 → ${BASELINE_PATH}`)
    console.log(`  通过率 ${pct(scores.passRate)}　任务 ${tasks.length} 条　k=${k}　种子 ${seed}`)
    console.log(
      `  指纹 model=${fingerprint.model} prompt=${fingerprint.promptVersion} tasks=${fingerprint.taskSetVersion}`
    )
    return
  }

  // ---- 跑门禁 ----
  const baseline = readBaseline(BASELINE_PATH)
  if (!baseline) {
    console.error(`没有找到基线 ${BASELINE_PATH}。先跑一次 --record。`)
    process.exit(2)
  }

  const config = gateFor(tier)
  const result = await runGate(
    { baseline, fingerprint, scores },
    async (rk) => runSuite(tasks, makeTarget(), rk, undefined),
    config
  )

  const label = { pass: '通过', warn: '警告', block: '拦截' }[result.status]
  console.log(`门禁：${label}`)
  console.log(`  基线通过率 ${pct(result.baselinePassRate)}　本次 ${pct(result.currentPassRate)}`)
  if (result.reran) console.log(`  已触发灰区复跑（k=${config.rerunK}）`)
  for (const r of result.reasons) console.log(`  · ${r}`)

  const code = exitCodeFor(result.status)
  if (code !== 0) {
    console.log('')
    console.log('退出码非零，合并被拦住。排查从这里开始：')
    console.log(`  1. 用基线里的种子 ${baseline.seed} 复现那一次运行`)
    console.log('  2. 读几条失败试次的轨迹，先判断是 Agent 退化还是判分写错了')
    console.log('  3. 确认是有意的行为变更之后，才重新 --record 一份基线')
  }
  process.exit(code)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
