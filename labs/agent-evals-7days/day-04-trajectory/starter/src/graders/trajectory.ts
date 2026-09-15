/**
 * 轨迹评分器 —— D4 新增模块。
 *
 * D1 立下的原则是「查它产生了什么，不要查它走了哪几步」。这条原则没有被推翻，
 * 今天做的是给它划边界：**过程只在它本身就构成问题的时候才去查。**
 *
 * 只有三种过程问题值得写进评分器：
 *   1. 必要的前置调用被跳过了（该调没调）——靶子的缺陷 2
 *   2. 碰了一个明令禁止的工具（不该调却调了）
 *   3. 陷入重复调用，或者超出了步数与花费预算——靶子的缺陷 3
 *
 * 反过来，**工具的完整顺序、调用次数、用了哪条捷径，一律不判**。
 * 把「必须先 A 再 B 再 C」写死进评分器，会在 Agent 找到更省的解法时判它失败，
 * 而那正是你想要的改进。
 *
 * 设计上有一条与 D1 一致的纪律：**策略是纯数据，按 taskId 查表**。
 * 这样一份策略表能和基准集一起进 git、被人 review，而不是散落在代码里。
 */

import type {
  GradeResult,
  Grader,
  Task,
  TaskReport,
  ToolCall,
  ToolName,
  Trial,
} from '../core/types'

// ---------------------------------------------------------------------------
// 策略：一条任务允许什么样的轨迹
// ---------------------------------------------------------------------------

/**
 * 必要前置关系：`before` 必须在**第一次** `after` 之前至少出现过一次。
 *
 * 注意它判的是**偏序**，不是全序。`[check_policy, issue_refund]` 的含义是
 * 「退款之前得查过政策」，它不关心中间还调了什么、查了几次、顺序里还夹了谁。
 */
export interface Precedence {
  before: ToolName
  after: ToolName
}

export interface TrajectoryPolicy {
  /** 必要前置关系。只写真正必要的，写多了就是在惩罚更聪明的解法 */
  requireBefore?: Precedence[]
  /** 这条任务下绝对不该被调用的工具 */
  forbidden?: ToolName[]
  /**
   * 同一个工具 + 同一组参数，最多允许重复出现几次。
   * **阈值按任务定**：查一次订单够了的任务给 2，需要轮询状态的任务可能给 10。
   */
  maxRepeats?: number
  /** 整条轨迹最多几次工具调用 */
  maxSteps?: number
  /** 整条轨迹最多花多少分钱 */
  maxCostCents?: number
}

/** 按 taskId 查策略。缺省策略用 `'*'` 这个键。 */
export type PolicyTable = Record<string, TrajectoryPolicy>

/** 取一条任务的策略：先找 taskId，再退回 `'*'`，都没有就是空策略（什么都不判）。 */
export function policyFor(table: PolicyTable, taskId: string): TrajectoryPolicy {
  return table[taskId] ?? table['*'] ?? {}
}

// ---------------------------------------------------------------------------
// 1. 工具序列：该调没调 / 不该调却调了
// ---------------------------------------------------------------------------

export type SequenceViolationKind = 'missing-prerequisite' | 'forbidden-tool'

export interface SequenceViolation {
  kind: SequenceViolationKind
  tool: ToolName
  detail: string
}

/**
 * 判工具序列。
 *
 * ⚠️ 两类违规的危险程度**不一样**，这是今天最重要的一条：
 *
 * - 「该调没调」（少查了政策）往往还是会被结果态抓到——它多半会导致退错款。
 * - 「不该调却调了」（碰了升级工单、发了邮件、动了别人的订单）**经常结果态是对的**：
 *   用户要的退款退了，任务判通过，而那次越权调用没有任何人看见。
 *
 * 所以 forbidden 这一条不是锦上添花，它是结果态评分器**结构上覆盖不到**的那一块。
 */
export function checkSequence(
  toolCalls: readonly ToolCall[],
  policy: TrajectoryPolicy
): SequenceViolation[] {
  const violations: SequenceViolation[] = []

  // TODO 练习 1：实现工具序列判定。
  //
  // a) policy.requireBefore 的每一条 { before, after }：
  //    找到**第一次** after 的位置。没调过 after 就跳过（规则是空谈，不算违规）。
  //    在它之前的调用里如果一次 before 都没有，push 一条 missing-prerequisite。
  //    ⚠️ 判的是偏序：中间夹了别的调用、before 调了三次，都不算违规。
  //       写成「必须紧邻前一步」会在 Agent 找到更聪明的解法时误杀。
  //
  // b) policy.forbidden 里的每个工具名：只要出现过一次就 push 一条 forbidden-tool，
  //    detail 里带上出现次数。
  //
  // detail 的文案会被自检和归因表匹配，照下面两句写：
  //    `调用 ${rule.after} 之前没有调用过 ${rule.before}`
  //    `调用了本任务禁止的工具 ${name}（${hits} 次）`
  void toolCalls
  void policy

  return violations
}

// ---------------------------------------------------------------------------
// 2. 循环检测
// ---------------------------------------------------------------------------

export interface LoopReport {
  looped: boolean
  /** 重复次数最多的那个调用签名 */
  signature: string
  /** 它重复了几次 */
  maxRepeats: number
}

/**
 * 一次工具调用的签名 = 工具名 + 规范化后的参数。
 *
 * 参数要**按键排序**再序列化：`{a:1,b:2}` 与 `{b:2,a:1}` 是同一次调用，
 * 直接 JSON.stringify 会把它们当成两次，于是死循环检测不出来。
 */
export function callSignature(c: ToolCall): string {
  const keys = Object.keys(c.args).sort()
  const parts = keys.map((k) => `${k}=${JSON.stringify(c.args[k])}`)
  return `${c.name}(${parts.join(',')})`
}

/**
 * 检出重复调用。
 *
 * 判据是「**同一个工具 + 完全相同的参数**出现了 N 次」，不是「同一个工具出现了 N 次」。
 * 后者会把合法的批量操作（查十个不同订单）误判成死循环，这是最常见的误伤。
 *
 * 阈值 `maxRepeats` 必须**按任务定**，理由见 README：
 * 查一次就有结果的任务给 2 就够，而轮询一个异步任务状态本来就要查十几次。
 * 定一个全局阈值，只能在「漏掉一半死循环」和「误伤一半正常任务」之间挑一个。
 */
export function detectLoop(toolCalls: readonly ToolCall[], maxRepeats: number): LoopReport {
  // TODO 练习 2：实现循环检测。
  //
  // 用 callSignature 给每次调用算签名，统计每个签名出现了几次，
  // 取出现次数最多的那个，次数超过 maxRepeats 就是 looped。
  //
  // ⚠️ 统计的键必须是「工具名 + 参数」的签名，不能只按工具名。
  //    只按工具名会把「查十个不同的订单」误判成死循环，这是最常见的误伤。
  void toolCalls
  void maxRepeats

  return { looped: false, signature: '', maxRepeats: 0 }
}

// ---------------------------------------------------------------------------
// 3. 预算：把「做到了」升级成「在预算内做到了」
// ---------------------------------------------------------------------------

export interface BudgetReport {
  steps: number
  costCents: number
  overSteps: boolean
  overCost: boolean
}

export function checkBudget(trial: Trial, policy: TrajectoryPolicy): BudgetReport {
  const steps = trial.transcript.toolCalls.length
  const costCents = trial.transcript.costCents
  return {
    steps,
    costCents,
    overSteps: policy.maxSteps !== undefined && steps > policy.maxSteps,
    overCost: policy.maxCostCents !== undefined && costCents > policy.maxCostCents,
  }
}

// ---------------------------------------------------------------------------
// 三个评分器
// ---------------------------------------------------------------------------

/** 工具序列评分器。违规一条就判失败，理由里带上全部违规。 */
export function makeSequenceGrader(table: PolicyTable): Grader {
  return function sequenceGrader(trial: Trial, task: Task): GradeResult {
    if (trial.error) {
      return { passed: false, score: 0, reason: `运行出错：${trial.error}`, grader: 'sequence' }
    }
    const violations = checkSequence(trial.transcript.toolCalls, policyFor(table, task.id))
    if (violations.length === 0) {
      return {
        passed: true,
        score: 1,
        reason: '工具序列满足全部必要前置与禁用规则',
        grader: 'sequence',
      }
    }
    return {
      passed: false,
      score: 0,
      reason: violations.map((v) => v.detail).join('；'),
      grader: 'sequence',
    }
  }
}

/** 循环评分器。没配 maxRepeats 的任务默认给 3 —— 比它更宽就不算「反复」了。 */
export const DEFAULT_MAX_REPEATS = 3

export function makeLoopGrader(table: PolicyTable): Grader {
  return function loopGrader(trial: Trial, task: Task): GradeResult {
    if (trial.error) {
      return { passed: false, score: 0, reason: `运行出错：${trial.error}`, grader: 'loop' }
    }
    const policy = policyFor(table, task.id)
    const limit = policy.maxRepeats ?? DEFAULT_MAX_REPEATS
    const report = detectLoop(trial.transcript.toolCalls, limit)
    if (!report.looped) {
      return {
        passed: true,
        score: 1,
        reason: `最多重复 ${report.maxRepeats} 次，阈值 ${limit}`,
        grader: 'loop',
      }
    }
    return {
      passed: false,
      score: 0,
      reason: `疑似死循环：${report.signature} 重复了 ${report.maxRepeats} 次，阈值 ${limit}`,
      grader: 'loop',
    }
  }
}

/** 预算评分器。步数与花费任一超标就失败。 */
export function makeBudgetGrader(table: PolicyTable): Grader {
  return function budgetGrader(trial: Trial, task: Task): GradeResult {
    if (trial.error) {
      return { passed: false, score: 0, reason: `运行出错：${trial.error}`, grader: 'budget' }
    }
    const policy = policyFor(table, task.id)
    const report = checkBudget(trial, policy)
    const problems: string[] = []
    if (report.overSteps) problems.push(`步数 ${report.steps} 超过预算 ${policy.maxSteps}`)
    if (report.overCost) {
      problems.push(`花费 ${report.costCents.toFixed(2)} 分超过预算 ${policy.maxCostCents} 分`)
    }
    if (problems.length === 0) {
      return {
        passed: true,
        score: 1,
        reason: `${report.steps} 步 / ${report.costCents.toFixed(2)} 分，在预算内`,
        grader: 'budget',
      }
    }
    return { passed: false, score: 0, reason: problems.join('；'), grader: 'budget' }
  }
}

/** 把三个轨迹评分器和策略表一起注册进注册表，供 runner 按名字取用。 */
export function trajectoryGraders(table: PolicyTable): Record<string, Grader> {
  return {
    sequence: makeSequenceGrader(table),
    loop: makeLoopGrader(table),
    budget: makeBudgetGrader(table),
  }
}

// ---------------------------------------------------------------------------
// 4. 失败归因
// ---------------------------------------------------------------------------

/**
 * 失败的桶。一个总成功率是没法指导行动的——
 * 「30% 失败」告诉不了你下一步该修哪里，「30% 失败里 8 成是跳过政策检查」可以。
 */
export type FailureBucket =
  | 'crash'
  | 'missing-prerequisite'
  | 'forbidden-tool'
  | 'loop'
  | 'over-budget'
  | 'outcome-mismatch'
  | 'unknown'

export interface AttributionRow {
  bucket: FailureBucket
  count: number
  share: number
  /** 一条样例理由，用来直接跳到现场 */
  example: string
}

export interface Attribution {
  totalTrials: number
  failedTrials: number
  rows: AttributionRow[]
}

/**
 * 把一条失败试次归到一个桶里。
 *
 * ⚠️ **一次试次只归一个桶**，按「越靠近根因越优先」排序：
 * 崩溃 > 越权调用 > 缺前置 > 死循环 > 超预算 > 结果态不符。
 * 结果态排最后不是因为它不重要，而是因为它通常是**上面几条的后果**——
 * 把它排前面，归因表会变成一列「结果不对」，等于没归因。
 */
export function bucketOf(grades: readonly GradeResult[], trial?: Trial): FailureBucket {
  if (trial?.error) return 'crash'
  const failed = grades.filter((g) => !g.passed)
  if (failed.length === 0) return 'unknown'

  const has = (grader: string, keyword?: string): boolean =>
    failed.some((g) => g.grader === grader && (keyword === undefined || g.reason.includes(keyword)))

  if (has('sequence', '禁止的工具')) return 'forbidden-tool'
  if (has('sequence')) return 'missing-prerequisite'
  if (has('loop')) return 'loop'
  if (has('budget')) return 'over-budget'
  if (has('outcome')) return 'outcome-mismatch'
  return 'unknown'
}

/** 把一批任务报告里的失败试次分桶，按占比从高到低排。 */
export function attributeFailures(reports: readonly TaskReport[]): Attribution {
  // TODO 练习 3：实现失败归因。
  //
  // 遍历每个任务报告的每一次试次：通过的只计入 totalTrials，失败的用 bucketOf 分桶，
  // 并为每个桶记下第一条样例理由（形如 `${taskId}#${i} ${reason}`）。
  //
  // ⚠️ share 的分母是**失败数**而不是总数：这张表回答的是「失败都是怎么失败的」，
  //    分母用总数会让归因表随着套件变大而整体缩水，失去可比性。
  //
  // 最后按 count 从高到低排序（相同再按桶名排，保证输出可复现）。
  void reports
  void bucketOf

  const rows: AttributionRow[] = []
  return { totalTrials: 0, failedTrials: 0, rows }
}
