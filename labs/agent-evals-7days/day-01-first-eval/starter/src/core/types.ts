/**
 * evalkit 的类型层 —— 全课七天的共同地基。
 *
 * ⚠️ 冻结文件：D1 定稿，D2–D7 逐字复制，不许改。
 *    改动后必须跑 bash scripts/check-evals-consistency.sh。
 *    本文件已进仓库根 .prettierignore（prettier 会重排联合类型，导致跨天副本不一致）。
 *
 * 这里的五个核心名词全课统一，中文译名见连贯性卡片 §4.1：
 *   Task 任务 / Trial 试次 / Grader 评分器 / Transcript 轨迹 / Outcome 结果态
 *
 * 一条贯穿全课的设计决定：**Task 是纯数据，Grader 是按名字注册的函数**。
 * 如果把 Grader 函数直接塞进 Task，基准集就没法用 JSON 存了——而 D2 起
 * 基准集必须是能被人 review、能进 git diff 的普通文件。
 */

// ---------------------------------------------------------------------------
// 结果态：环境的最终状态。注意它不是聊天记录里的一句话。
// Agent 说「已为您退款」和退款记录真的存在，是两件事。
// ---------------------------------------------------------------------------

/** 一笔订单。ageDays 是下单到现在的天数，退款策略按它判定。 */
export interface Order {
  id: string
  amountCents: number
  ageDays: number
  /** 已经退过款的订单不能再退 */
  refunded: boolean
}

/** 一条退款记录。这是「退款成功」唯一可信的证据。 */
export interface Refund {
  orderId: string
  amountCents: number
}

/** 一次升级人工。 */
export interface Escalation {
  orderId: string
  reason: string
}

/**
 * 结果态 = 一次试次跑完之后，世界长什么样。
 * 评分器的第一选择永远是查这里，而不是去读 Agent 的自述。
 */
export interface WorldState {
  orders: Record<string, Order>
  refunds: Refund[]
  escalations: Escalation[]
}

// ---------------------------------------------------------------------------
// 轨迹：一次试次的完整过程记录
// ---------------------------------------------------------------------------

/** 本课靶子 Agent 的四个工具。D4 的工具序列评分器按这四个名字判定。 */
export type ToolName = 'lookup_order' | 'check_policy' | 'issue_refund' | 'escalate'

/** 一次工具调用的完整记录。D4 起会用到 args 与 durationMs。 */
export interface ToolCall {
  name: ToolName
  args: Record<string, unknown>
  result: unknown
  durationMs: number
}

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
}

/**
 * 轨迹 = 一次试次的完整记录。
 *
 * ⚠️ 术语警告：本课的「轨迹」指的是这个结构，
 * 与 D5 的 trace（OpenTelemetry 的链路）是两个概念，不要混用。
 */
export interface Transcript {
  messages: Message[]
  toolCalls: ToolCall[]
  inputTokens: number
  outputTokens: number
  /** 以分为单位。用整数避免浮点累加误差——成本要能对得上账。 */
  costCents: number
  durationMs: number
}

// ---------------------------------------------------------------------------
// 任务：纯数据，可以直接存成 JSON
// ---------------------------------------------------------------------------

/**
 * 正向还是反向。
 *
 * negative 是最容易被漏掉的一半：只测「该退款时退了」，
 * 会养出一个见谁都退款的 Agent。见连贯性卡片 §3.5 的「双向测试」。
 */
export type Polarity = 'positive' | 'negative'

/** 任务的初始环境。每个试次都从它重建一份全新的世界，绝不共享状态。 */
export interface TaskSeed {
  orders: Order[]
}

/** 任务对结果态的期望。评分器拿它和真实结果态比对。 */
export interface Expectation {
  /** 期望存在的退款；空数组表示「不应该有任何退款」 */
  refunds?: Refund[]
  /** 期望升级人工的订单号 */
  escalations?: string[]
}

export interface Task {
  id: string
  /** 用户说的话 */
  prompt: string
  polarity: Polarity
  seed: TaskSeed
  expect: Expectation
  /** 评分器名字，从注册表里取。空数组表示只用默认的结果态评分器。 */
  graders: string[]
  /** 自由标签，D7 的套件体检按它分组 */
  tags?: string[]
}

// ---------------------------------------------------------------------------
// 试次与评分
// ---------------------------------------------------------------------------

/** 一次试次 = 对同一个任务的一次运行。同一任务要跑多次才有意义。 */
export interface Trial {
  taskId: string
  /** 第几次，从 0 开始 */
  index: number
  transcript: Transcript
  outcome: WorldState
  /** 运行本身崩了（不是判分不通过）。崩溃也是一种失败，不能当成 0 分静默吞掉。 */
  error?: string
}

export interface GradeResult {
  passed: boolean
  /** 0..1。二值评分器直接给 0 或 1；D3 的模型型评分器会给中间值。 */
  score: number
  /** 为什么。空字符串是不允许的——一条没有理由的失败无法排查。 */
  reason: string
  /** 哪个评分器给的 */
  grader: string
}

/** 评分器：看一次试次，给一个结论。允许异步（D3 的模型型评分器要调网络）。 */
export type Grader = (trial: Trial, task: Task) => GradeResult | Promise<GradeResult>

// ---------------------------------------------------------------------------
// 运行结果
// ---------------------------------------------------------------------------

/** 一个任务跑 k 次之后的汇总。 */
export interface TaskReport {
  taskId: string
  polarity: Polarity
  /** k 次试次各自的评分结果（每次可能有多个评分器） */
  grades: GradeResult[][]
  /** 每次试次是否整体通过：该次的所有评分器都通过才算通过 */
  passed: boolean[]
  /** k 次里至少成功一次 */
  passAtK: boolean
  /** k 次全部成功 */
  passHatK: boolean
  trials: Trial[]
}

/** 整个套件跑完之后的汇总。 */
export interface SuiteReport {
  /** 每个任务重复跑了几次 */
  k: number
  tasks: TaskReport[]
  /** 跨任务平均：至少成一次的任务占比 */
  passAtKRate: number
  /** 跨任务平均：k 次全成的任务占比 */
  passHatKRate: number
  totalCostCents: number
  totalDurationMs: number
}

/** 被评估的对象。靶子 Agent 实现它；换成你自己的 Agent 也只要实现它。 */
export interface EvalTarget {
  name: string
  run(task: Task, world: WorldState): Promise<Transcript>
}
