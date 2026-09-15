/**
 * 试次执行器 —— 把「跑一次看看」变成「跑 k 次算两个概率」。
 *
 * ⚠️ 冻结文件：D1 定稿，D2–D7 逐字复制，不许改。
 *    改动后必须跑 bash scripts/check-evals-consistency.sh。
 *
 * 这里有两条不可退让的纪律：
 *
 * 1. **每个试次都从干净环境起步**。世界状态是 deepClone 出来的，绝不在试次之间共享。
 *    共享状态会产出两种假信号：前一次退过款让后一次「看起来」成功了（虚假通过），
 *    或者前一次把订单改脏导致后面全挂（相关失败）。两种都会让你去修根本不存在的 bug。
 *
 * 2. **崩溃不等于 0 分**。Agent 抛异常时 trial.error 有值，这条试次照样计入分母，
 *    但错误原因要能一路带到报告里——静默吞掉异常是评估系统最常见的自欺。
 */

import type {
  EvalTarget,
  GradeResult,
  Grader,
  SuiteReport,
  Task,
  TaskReport,
  Transcript,
  Trial,
  WorldState,
} from './types'

/** 从任务的 seed 造一个全新的世界。每个试次调一次。 */
export function buildWorld(task: Task): WorldState {
  const orders: WorldState['orders'] = {}
  for (const o of task.seed.orders) {
    // 展开成新对象，避免任务定义里的 order 被试次改写后污染后续试次
    orders[o.id] = { ...o }
  }
  return { orders, refunds: [], escalations: [] }
}

/** 出错时的空轨迹。保持字段齐全，下游聚合不用到处判 undefined。 */
function emptyTranscript(): Transcript {
  return {
    messages: [],
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    durationMs: 0,
  }
}

/**
 * 默认评分器：只看结果态。
 *
 * 这是全课的第一选择——能用代码判的绝不交给模型。
 * 它判三件事：该有的退款有没有、不该有的退款是不是真没有、该升级的升没升。
 */
export function outcomeGrader(trial: Trial, task: Task): GradeResult {
  if (trial.error) {
    return { passed: false, score: 0, reason: `运行出错：${trial.error}`, grader: 'outcome' }
  }

  const want = task.expect.refunds ?? []
  const got = trial.outcome.refunds

  if (got.length !== want.length) {
    return {
      passed: false,
      score: 0,
      reason: `退款条数不符：期望 ${want.length} 条，实际 ${got.length} 条`,
      grader: 'outcome',
    }
  }

  for (const w of want) {
    const hit = got.find((g) => g.orderId === w.orderId && g.amountCents === w.amountCents)
    if (!hit) {
      return {
        passed: false,
        score: 0,
        reason: `缺少期望的退款：订单 ${w.orderId} 金额 ${w.amountCents} 分`,
        grader: 'outcome',
      }
    }
  }

  const wantEsc = task.expect.escalations ?? []
  for (const id of wantEsc) {
    if (!trial.outcome.escalations.some((e) => e.orderId === id)) {
      return {
        passed: false,
        score: 0,
        reason: `订单 ${id} 应该升级人工但没有`,
        grader: 'outcome',
      }
    }
  }

  return { passed: true, score: 1, reason: '结果态与期望一致', grader: 'outcome' }
}

/** 评分器注册表。D2 起基准集里写名字，从这里取实现。 */
export const graderRegistry: Record<string, Grader> = {
  outcome: outcomeGrader,
}

/** 跑一次试次：干净世界 + 一次 Agent 运行 + 全部评分器。 */
export async function runTrial(
  task: Task,
  target: EvalTarget,
  index: number,
  registry: Record<string, Grader> = graderRegistry
): Promise<{ trial: Trial; grades: GradeResult[] }> {
  const world = buildWorld(task)
  let transcript: Transcript
  let error: string | undefined

  try {
    transcript = await target.run(task, world)
  } catch (e) {
    transcript = emptyTranscript()
    error = e instanceof Error ? e.message : String(e)
  }

  const trial: Trial = { taskId: task.id, index, transcript, outcome: world, error }

  // 没写 graders 的任务默认只过结果态评分器
  const names = task.graders.length > 0 ? task.graders : ['outcome']
  const grades: GradeResult[] = []
  for (const name of names) {
    const grader = registry[name]
    if (!grader) {
      grades.push({
        passed: false,
        score: 0,
        reason: `评分器 ${name} 未注册`,
        grader: name,
      })
      continue
    }
    grades.push(await grader(trial, task))
  }

  return { trial, grades }
}

/**
 * 跑一个任务 k 次。
 *
 * passAtK  = k 次里至少一次全部评分器都通过
 * passHatK = k 次每一次都全部评分器通过
 *
 * 两个指标的定义出自 tau-bench 论文（arXiv 2406.12045）。
 */
export async function runTask(
  task: Task,
  target: EvalTarget,
  k: number,
  registry: Record<string, Grader> = graderRegistry
): Promise<TaskReport> {
  const trials: Trial[] = []
  const allGrades: GradeResult[][] = []
  const passed: boolean[] = []

  for (let i = 0; i < k; i += 1) {
    const { trial, grades } = await runTrial(task, target, i, registry)
    trials.push(trial)
    allGrades.push(grades)
    // 一次试次通过 = 它的每一个评分器都通过
    passed.push(grades.length > 0 && grades.every((g) => g.passed))
  }

  return {
    taskId: task.id,
    polarity: task.polarity,
    grades: allGrades,
    passed,
    passAtK: passed.some(Boolean),
    passHatK: passed.every(Boolean),
    trials,
  }
}

/** 跑整个套件，并按任务平均出两个比率。 */
export async function runSuite(
  tasks: Task[],
  target: EvalTarget,
  k: number,
  registry: Record<string, Grader> = graderRegistry
): Promise<SuiteReport> {
  const reports: TaskReport[] = []
  for (const task of tasks) {
    reports.push(await runTask(task, target, k, registry))
  }

  const n = reports.length
  let costCents = 0
  let durationMs = 0
  for (const r of reports) {
    for (const t of r.trials) {
      costCents += t.transcript.costCents
      durationMs += t.transcript.durationMs
    }
  }

  return {
    k,
    tasks: reports,
    // n 为 0 时返回 0 而不是 NaN：一个空套件的分数是 0，不是「未定义」
    passAtKRate: n === 0 ? 0 : reports.filter((r) => r.passAtK).length / n,
    passHatKRate: n === 0 ? 0 : reports.filter((r) => r.passHatK).length / n,
    totalCostCents: costCents,
    totalDurationMs: durationMs,
  }
}
