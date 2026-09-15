/**
 * 批量运行。本天新增：把一道题从「摆好初始状态」到「判完分」跑完，再把五道题跑一遍。
 *
 * 每一次尝试都是**独立**的：重新 seed 一次沙盒仓库、重新建一个会话、重新扫一遍技能。
 * 不复用是刻意的——上一题留下的文件改动或对话历史会让这一题的结果无法解释，
 * 而基准集最要紧的性质就是「同样的输入给出同样的结果」。
 *
 * 变体（variant）是这一天的 A/B 开关：同一批题、同一套判分，只改系统提示末尾那一句。
 * **离线下这个 A/B 只测得出成本，测不出效果**——模型的回答是剧本写死的，
 * 提示词改了它也不会换一条路走。这不是实验的缺陷，是评估的一条性质：
 * 要测行为变化必须接真实网关，而且同一题要跑多次看方差。正文那节会展开。
 */
import { seedRepo, REPO_DIR } from '../seed.js'
import { SessionLog } from '../session/log.js'
import { newSession } from '../session-factory.js'
import { runTurn } from '../turn.js'
import { createProvider } from '../providers/index.js'
import { scanSkills } from '../skills/scan.js'
import { contentToText } from '../kernel/types.js'
import { loadConfig } from '../config.js'
import { loadRates } from './cost.js'
import { readRepo, runTests } from './grade.js'
import { TASKS, type Task } from './tasks.js'
import { UsageMeter } from './meter.js'
import { summarize, type Attempt, type RunReport, type VariantReport } from './report.js'

export interface Variant {
  id: string
  label: string
  /** 拼在系统提示末尾的那一句。空字符串表示原样不动 */
  systemSuffix: string
}

export const VARIANTS: Variant[] = [
  { id: 'baseline', label: '基线：系统提示原样不动', systemSuffix: '' },
  {
    id: 'test-first',
    label: '改一处提示词：动手前先跑测试',
    systemSuffix: '动手改任何文件之前，先跑一遍测试，确认失败的用例到底是哪一个，再决定改什么。',
  },
]

export interface RunOptions {
  tasks?: Task[]
  variants?: Variant[]
  /** 同一题跑几次。想看抖动就把它调大 */
  repeat?: number
  onProgress?: (line: string) => void
}

async function runOnce(task: Task, variant: Variant, attempt: number): Promise<Attempt> {
  // 1. 摆初始状态：先 seed 回原样，再让这道题自己改成它要的样子
  await seedRepo()
  await task.setup?.(REPO_DIR)
  const before = await readRepo(REPO_DIR)

  // 2. 建一个全新会话。技能每次重新扫，好让第三题的技能注入真的发生
  const scanned = await scanSkills()
  const session = newSession(() => {}, await SessionLog.create(), {
    skills: { ...scanned, pinned: [] },
  })
  // 变体在这里生效：只动系统提示末尾那一句，别的一个字都不改
  if (variant.systemSuffix) {
    const system = session.messages[0]
    if (system) system.content = `${contentToText(system.content)}${variant.systemSuffix}`
  }

  // 3. 跑一轮。评估里一律自动批准：审批是给人用的，基准集要的是无人值守可重复
  const meter = new UsageMeter()
  const startedAt = Date.now()
  const turn = await runTurn({
    session,
    provider: createProvider(),
    line: task.prompt,
    write: () => {},
    out: () => {},
    approve: async () => ({ approved: true, scope: 'session' }),
    meter,
    tty: false,
  })
  const elapsedMs = Date.now() - startedAt

  // 4. 判分：先自己跑一遍测试，再读终态，然后逐条算判据
  const tests = await runTests(REPO_DIR)
  const now = await readRepo(REPO_DIR)
  const ctx = {
    repoDir: REPO_DIR,
    testsPass: tests.pass,
    testOutput: tests.output,
    now: (relative: string) => now.get(relative),
    before: (relative: string) => before.get(relative),
  }
  const checks = task.checks.map((check) => ({ label: check.label, ok: check.run(ctx) }))

  // 5. 工具那几列直接取 RenderSummary.tools，不在这里重新数一遍
  const tools = turn.summary.tools
  return {
    taskId: task.id,
    title: task.title,
    difficulty: task.difficulty,
    variantId: variant.id,
    attempt,
    passed: checks.every((c) => c.ok),
    checks,
    rounds: meter.rounds,
    promptTokens: meter.promptTokens,
    completionTokens: meter.completionTokens,
    cachedTokens: meter.cachedTokens,
    totalTokens: meter.totalTokens,
    toolCalls: tools.length,
    toolFailures: tools.filter((t) => !t.ok).length,
    truncated: tools.filter((t) => t.truncated).length,
    elapsedMs,
  }
}

function newRunId(): string {
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `r-${now}-${Math.random().toString(36).slice(2, 6)}`
}

export async function runBenchmark(options: RunOptions = {}): Promise<RunReport> {
  const tasks = options.tasks ?? TASKS
  const variants = options.variants ?? VARIANTS
  const repeat = Math.max(1, options.repeat ?? 1)
  const rates = loadRates()
  const config = loadConfig()
  const report: RunReport = {
    runId: newRunId(),
    startedAt: new Date().toISOString(),
    mode: config.mock ? 'mock' : 'gateway',
    model: config.mock ? 'mock' : config.model,
    repeat,
    rates,
    variants: [],
  }

  for (const variant of variants) {
    const attempts: Attempt[] = []
    for (const task of tasks) {
      for (let i = 1; i <= repeat; i += 1) {
        const attempt = await runOnce(task, variant, i)
        attempts.push(attempt)
        options.onProgress?.(
          `  ${attempt.passed ? '✔' : '✘'} [${variant.id}] ${task.id} 第 ${i} 次` +
            ` · ${attempt.rounds} 轮 · ${attempt.totalTokens} token`
        )
      }
    }
    const entry: VariantReport = {
      variantId: variant.id,
      label: variant.label,
      attempts,
      summary: summarize(attempts, rates),
    }
    report.variants.push(entry)
  }
  return report
}
