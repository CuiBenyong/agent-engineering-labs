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
  // TODO(练习 1)：实现饱和检测。
  //
  // 判据是**连续 SATURATION_ROUNDS 轮**都 pass^k 满分，不是单轮。
  // 单轮满分太常见，按单轮报会让体检报告天天响，最后没人看。
  //
  // 要报两个层面：
  //   · 任务级：某条任务连续多轮 passHatK 都是 true（severity: 'info'）
  //   · 套件级：整体 passHatKRate 连续多轮不低于 0.98（severity: 'warn'）
  //
  // ⚠️ 自检第 1 条是**双向**的：稳定满分的要检出，**会抖的不能误报**。
  //    一个「只要见到 passHatK 为 true 就报」的实现会把会抖任务也标成饱和。
  void history
  return []
}

/**
 * 长期零分检测。
 *
 * 这条的措辞很重要：它报的是「**这条任务可疑**」，不是「Agent 做不到」。
 * 一条真正可解的难任务，跑很多次通常会蒙对至少一次；
 * 全零更像一堵墙而不是一个斜坡。
 */
export function detectAlwaysFailing(history: SuiteReport[]): HealthIssue[] {
  // TODO(练习 2)：实现长期零分检测。
  //
  // 判据：某条任务在**每一轮**里 passAtK 都是 false（一次都没蒙对过）。
  // detail 的措辞很重要——报的是「**这条任务可疑**」，不是「Agent 做不到」。
  // 一条真正可解的难任务，跑很多次通常会蒙对至少一次；
  // 全零更像一堵墙而不是一个斜坡。severity 用 'error'。
  //
  // ⚠️ 自检第 2 条是双向的：坏任务要检出，**正常任务不能误报**。
  void history
  return []
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
  // TODO(练习 3)：实现判分缺陷检测。
  //
  // 思路：扫每一条失败的评分理由，从中抽出数字。
  // 如果理由里出现了两个数字，而它们的**相对误差小于 0.001**，
  // 那多半是严格相等比较造成的误判，而不是 Agent 真的算错了。
  // 例如「期望 49.9，实际 49.89999999999999」。
  //
  // 两条要求：
  //   · 同一条任务**只报一次**（k 次试次会给出 k 条一样的理由，
  //     把同一个问题刷屏 k 遍，读的人会开始跳过整份报告）——自检第 6 条考这个
  //   · detail 里要带上原始 reason，否则没法复核
  void report
  return []
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
  // TODO(练习 4)：实现基线代表性检测。**这一条是全天最容易写出恒真实现的地方。**
  //
  // 要回答的问题：基线这个数字，是不是记在了一次运气特别好（或特别差）的运行上？
  // 做法是把基线放回同配置多次运行的分布里，看它落在哪。
  //   · 落在最高端 → 之后每次正常运行都像退化，门禁长期误报（severity: 'error'）
  //   · 落在最低端 → 门槛太低，真实退化会被放过去（severity: 'error'）
  //   · 落在中间   → 不报
  //
  // ⚠️⚠️ **先想清楚这个边界：如果所有运行的分数完全相同会怎样？**
  //    那时候基线必然**同时**是最高和最低，「落在最高端」这个判据恒成立，
  //    于是你的检测器会对每一个完全稳定的套件报警。
  //    **一个永远会响的检测器比没有检测器更糟**，它会让人学会无视整份报告。
  //    自检第 4 条专门考这个边界，第 5 条考另一个方向。
  //
  // 另外样本太少（少于 5 次）时谈不上分布，直接返回空。
  void baselineRate
  void noiseRates
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
