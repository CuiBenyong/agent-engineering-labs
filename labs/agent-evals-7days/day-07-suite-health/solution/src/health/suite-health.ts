/**
 * 套件体检 —— 把矛头转回评估系统自己。
 *
 * 前六天一直默认一件事：套件是对的，分数掉了就是 Agent 的问题。
 * 这一天要验的是那个默认假设本身。
 *
 * 六类问题，每一类都对应一种「分数还在、信息已经没了」的情形：
 *
 *   saturated                长期满分 —— 只剩回归价值，不再指方向
 *   always-failing           长期零分 —— 多半是任务坏了，不是 Agent 不行
 *   no-discrimination        谁做都能过 —— 这条任务从来没有区分过任何东西
 *   grading-defect           判分写错 —— 最贵的一类，见下面的 detectGradingDefect
 *   polarity-imbalance       只有正向没有反向 —— 会把 Agent 优化成「见谁都退款」
 *   unrepresentative-baseline 基线记在了极值上 —— D6 的门禁会因此长期误报
 */

import type { SuiteReport, Task, TaskReport } from '../core/types'

export type HealthKind =
  | 'saturated'
  | 'always-failing'
  | 'no-discrimination'
  | 'grading-defect'
  | 'polarity-imbalance'
  | 'unrepresentative-baseline'

export interface HealthIssue {
  kind: HealthKind
  /** 与具体某条任务有关时给出；套件级问题留空 */
  taskId?: string
  detail: string
  severity: 'info' | 'warn' | 'error'
}

/** 连续多少轮满分算饱和。三轮是经验值，太短会把偶然的好运判成饱和。 */
const SATURATION_ROUNDS = 3

/**
 * 饱和检测。
 *
 * 判据是**连续多轮**都 pass^k 满分，而不是单轮——单轮满分太常见，
 * 按单轮报会让体检报告天天响，最后没人看。
 *
 * ⚠️ 饱和**不是**缺陷，它是一个阶段信号：这条任务已经从「能力评估」
 * 退化成了「回归评估」。正确的动作是把它移进回归集，然后出更难的新题，
 * 而不是删掉它——删掉等于放弃了对这项能力的回归保护。
 */
export function detectSaturation(history: SuiteReport[]): HealthIssue[] {
  if (history.length < SATURATION_ROUNDS) return []
  const recent = history.slice(-SATURATION_ROUNDS)
  const issues: HealthIssue[] = []

  const taskIds = recent[0].tasks.map((t) => t.taskId)
  for (const id of taskIds) {
    const rows = recent.map((r) => r.tasks.find((t) => t.taskId === id))
    if (rows.some((r) => r === undefined)) continue
    if (rows.every((r) => r?.passHatK === true)) {
      issues.push({
        kind: 'saturated',
        taskId: id,
        detail: `连续 ${SATURATION_ROUNDS} 轮 pass^k 满分，已无改进信号，应移入回归集并补更难的新题`,
        severity: 'info',
      })
    }
  }

  // 套件级：整体逼近满分
  const lastRate = recent[recent.length - 1].passHatKRate
  if (recent.every((r) => r.passHatKRate >= 0.98)) {
    issues.push({
      kind: 'saturated',
      detail: `套件整体 pass^k 连续 ${SATURATION_ROUNDS} 轮不低于 98%（当前 ${(lastRate * 100).toFixed(1)}%），继续汇报这个分数已经不提供任何改进信息`,
      severity: 'warn',
    })
  }
  return issues
}

/**
 * 长期零分检测。
 *
 * 这条的措辞很重要：它报的是「**这条任务可疑**」，不是「Agent 做不到」。
 * 一条真正可解的难任务，跑很多次通常会蒙对至少一次；
 * 全零更像一堵墙而不是一个斜坡。
 */
export function detectAlwaysFailing(history: SuiteReport[]): HealthIssue[] {
  if (history.length === 0) return []
  const issues: HealthIssue[] = []
  const taskIds = history[0].tasks.map((t) => t.taskId)

  for (const id of taskIds) {
    const rows = history.map((r) => r.tasks.find((t) => t.taskId === id))
    if (rows.some((r) => r === undefined)) continue
    // pass@k 都为 false 意味着一次都没蒙对过
    if (rows.every((r) => r?.passAtK === false)) {
      const totalTrials = rows.reduce((n, r) => n + (r?.passed.length ?? 0), 0)
      issues.push({
        kind: 'always-failing',
        taskId: id,
        detail: `${totalTrials} 次试次一次都没通过。先怀疑任务本身：判据是否写错、描述是否有歧义、环境里是否缺东西，最后才是 Agent 不行`,
        severity: 'error',
      })
    }
  }
  return issues
}

/**
 * 无区分度检测。
 *
 * 一条任务如果「认真做的」和「乱做的」都能过，它从来没有区分过任何东西。
 * 判据用的是 D2 的三人小组：参考解 / 见单就退 / 什么都不做。
 */
export function detectNoDiscrimination(trivialTaskIds: readonly string[]): HealthIssue[] {
  return trivialTaskIds.map((id) => ({
    kind: 'no-discrimination' as const,
    taskId: id,
    detail: '参考解、乱做的、什么都不做的三种解法都能通过，这条任务不提供任何区分度',
    severity: 'error' as const,
  }))
}

/**
 * 正反比例失衡。
 *
 * 只测「该做时做了」，会优化出一个「什么都做一遍」的 Agent。
 * 阈值定在 30%：反向用例低于三成就提醒。这不是严格的统计依据，
 * 是一个「明显偏了」的经验线。
 */
export function detectPolarityImbalance(tasks: readonly Task[]): HealthIssue[] {
  if (tasks.length === 0) return []
  const negatives = tasks.filter((t) => t.polarity === 'negative').length
  const ratio = negatives / tasks.length
  if (ratio >= 0.3) return []
  return [
    {
      kind: 'polarity-imbalance',
      detail: `反向用例只占 ${(ratio * 100).toFixed(0)}%（${negatives}/${tasks.length}）。只测正向会把 Agent 优化成「见谁都退款」，双向测试不是可选项`,
      severity: 'warn',
    },
  ]
}

/**
 * 判分缺陷检测：**最贵的一类问题**。
 *
 * 真实案例：某模型在一个公开基准上初评 42 分，排查发现是判分用了严格字符串比较——
 * 「96.12」与「96.124991…」被判为不相等。修好判分之后，同一个模型同一套件得 95 分。
 * **53 个百分点的差距，全部来自评估本身的缺陷，与模型能力毫无关系。**
 *
 * 这里检的是那一类缺陷的可自动发现的部分：
 * 失败理由里出现了「数值看起来只差一点点」的模式。
 *
 * ⚠️ 这个检测器**只能发现一部分**判分缺陷。真正兜底的是人读轨迹，
 * 这也是为什么 D7 要把「随机抽样读轨迹」写成例行动作而不是建议。
 */
export function detectGradingDefect(report: SuiteReport): HealthIssue[] {
  const issues: HealthIssue[] = []
  for (const task of report.tasks) {
    // 同一条任务的 k 次试次会给出 k 条一模一样的理由。
    // 按任务报一次就够了——把同一个问题刷屏 k 遍，读的人会开始跳过整份报告。
    let reported = false
    for (const grades of task.grades) {
      if (reported) break
      for (const g of grades) {
        if (g.passed) continue
        const nums = g.reason.match(/-?\d+\.\d+|-?\d+/g)
        if (!nums || nums.length < 2) continue
        const [a, b] = [Number(nums[0]), Number(nums[1])]
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue
        // 两个数字非常接近却判了失败：典型的严格相等比较缺陷
        const diff = Math.abs(a - b)
        const scale = Math.max(Math.abs(a), Math.abs(b), 1)
        if (diff > 0 && diff / scale < 0.001) {
          issues.push({
            kind: 'grading-defect',
            taskId: task.taskId,
            detail: `失败理由里的两个数字只差 ${diff}（相对误差 ${(diff / scale).toExponential(1)}），像是严格相等比较造成的误判而不是真的做错：「${g.reason}」`,
            severity: 'error',
          })
          reported = true
          break
        }
      }
    }
  }
  return issues
}

/**
 * 基线代表性检测。
 *
 * **这一条补的是 D6 留下的缺口。** D6 教了怎么记基线、怎么定阈值，
 * 但没回答一个前置问题：**基线本身记在哪一次上？**
 *
 * 如果基线恰好记在一次运气特别好的运行上，后面每一次正常运行都会显得像退化，
 * 门禁会长期误报，团队很快就学会无视它——**一个天天喊狼来了的门禁，
 * 比没有门禁更糟，因为它让所有人相信自己是有保护的。**
 * 反过来，基线记在一次特别差的运行上，真实退化会被这个低门槛放过去。
 *
 * 判据：把基线分数放回同配置多次运行的分布里，看它是不是落在了两端。
 */
export function detectUnrepresentativeBaseline(
  baselineRate: number,
  noiseRates: readonly number[]
): HealthIssue[] {
  if (noiseRates.length < 5) return []
  const sorted = [...noiseRates].sort((a, b) => a - b)
  const lo = sorted[0]
  const hi = sorted[sorted.length - 1]
  const mid = sorted[Math.floor(sorted.length / 2)]

  // ⚠️ 这一行是本文件写第一版时踩的坑，留着当教训：
  // 如果这套配置根本不抖（所有运行分数相同，lo === hi），
  // 那么「基线落在最高端」这个判据**恒成立**——基线必然同时是最高和最低。
  // 于是检测器会对每一个完全稳定的套件报警，而报警文本还言之凿凿。
  // **一个永远会响的检测器，比没有检测器更糟**，因为它会让人学会无视整份报告。
  // 没有分布就谈不上代表性，直接返回空。
  if (hi - lo < 1e-9) return []

  // 落在分布之外，或正好压在最高/最低那一端
  if (baselineRate >= hi) {
    return [
      {
        kind: 'unrepresentative-baseline',
        detail: `基线 ${(baselineRate * 100).toFixed(1)}% 落在 ${noiseRates.length} 次同配置运行的最高端（区间 ${(lo * 100).toFixed(1)}%–${(hi * 100).toFixed(1)}%，中位 ${(mid * 100).toFixed(1)}%）。基线记在幸运的一次上，之后每次正常运行都会像退化，门禁会长期误报`,
        severity: 'error',
      },
    ]
  }
  if (baselineRate <= lo) {
    return [
      {
        kind: 'unrepresentative-baseline',
        detail: `基线 ${(baselineRate * 100).toFixed(1)}% 落在 ${noiseRates.length} 次同配置运行的最低端（区间 ${(lo * 100).toFixed(1)}%–${(hi * 100).toFixed(1)}%，中位 ${(mid * 100).toFixed(1)}%）。门槛太低，真实退化会被它放过去`,
        severity: 'error',
      },
    ]
  }
  return []
}

export interface HealthInput {
  /** 同一套件的多轮历史，最近的排最后 */
  history: SuiteReport[]
  tasks: readonly Task[]
  /** D2 的参考解体检认定无区分度的任务 */
  trivialTaskIds?: readonly string[]
  /** D6 的基线通过率与同配置多次运行的分布 */
  baselineRate?: number
  noiseRates?: readonly number[]
}

/** 跑完整体检。返回的问题按严重度排序，error 在前。 */
export function checkSuiteHealth(input: HealthInput): HealthIssue[] {
  const last = input.history[input.history.length - 1]
  const issues: HealthIssue[] = [
    ...detectSaturation(input.history),
    ...detectAlwaysFailing(input.history),
    ...detectNoDiscrimination(input.trivialTaskIds ?? []),
    ...detectPolarityImbalance(input.tasks),
    ...(last ? detectGradingDefect(last) : []),
    ...(input.baselineRate !== undefined && input.noiseRates
      ? detectUnrepresentativeBaseline(input.baselineRate, input.noiseRates)
      : []),
  ]
  const rank: Record<HealthIssue['severity'], number> = { error: 0, warn: 1, info: 2 }
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/**
 * 抽样读轨迹清单。
 *
 * 「除非有人真的读过几条轨迹，否则不要相信 eval 分数。」
 * 这句话只有变成一个**有具体条目的清单**才会真的被执行，
 * 所以这里把它做成函数而不是写进文档。
 *
 * 抽样规则刻意不是纯随机：失败样本必须进，因为它们信息密度最高；
 * 通过样本也要抽几条，否则你只会看到失败，形成「它什么都做不对」的错觉。
 */
export function buildReadingList(
  report: SuiteReport,
  sampleSize = 5
): Array<{ taskId: string; trialIndex: number; why: string }> {
  const list: Array<{ taskId: string; trialIndex: number; why: string }> = []

  for (const task of report.tasks) {
    const firstFail = task.passed.indexOf(false)
    if (firstFail !== -1) {
      list.push({ taskId: task.taskId, trialIndex: firstFail, why: '失败样本：信息密度最高' })
    }
  }
  // 抽几条通过的，避免只看失败形成偏见
  for (const task of report.tasks) {
    const firstPass = task.passed.indexOf(true)
    if (firstPass !== -1 && list.length < sampleSize + 2) {
      list.push({
        taskId: task.taskId,
        trialIndex: firstPass,
        why: '通过样本：确认它是因为做对了才通过，而不是判据太松',
      })
    }
  }
  return list.slice(0, sampleSize)
}
