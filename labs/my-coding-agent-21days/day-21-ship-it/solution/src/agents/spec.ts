/**
 * 子 Agent 的三套数据形状：派单、结果、合并计划。本天新增。
 *
 * 单独一个文件，是因为这三样东西被下面四个文件同时用到（worktree / run / merge / tool），
 * 放进任何一个都会让另外三个反向依赖它。
 *
 * **注意这里一个字段都没往 kernel/types.ts 里加。** 子 Agent 不是协议层的东西，
 * 它是「在循环外面再套一层循环」——Message、ToolDef、AgentEvent 三套协议一个字都不用改，
 * 这正是第十三天定下的那条口径（需要外部能力的工具用工厂函数注入依赖）。
 */
import type { RunLimits } from '../kernel/limits.js'

/** 一张派单：交给谁、干什么、能用哪些工具、给多少预算 */
export interface SubagentSpec {
  /** 工位号。同时也是工作树的目录名，所以只允许 a-z0-9- */
  id: string
  /** 交给它的一句话。**这是它看到的全部上下文** */
  task: string
  /** 工具白名单，按名字。空数组表示一个工具都不给（它只能说话） */
  allow: string[]
  /** 独立预算。不传就用 SUBAGENT_LIMITS */
  limits?: Partial<RunLimits>
}

/** 子 Agent 在自己工作树里造成的一处文件改动 */
export interface FileChange {
  path: string
  /** 派单时那一刻的内容。新建的文件是 null */
  before: string | null
  after: string
}

/**
 * 一份结构化回执。**主会话只看得到这个，看不到子 Agent 的消息数组。**
 *
 * 字段的取舍就是今天的一个教学点：回来的必须是「它干了什么、结果如何、花了多少」，
 * 不是「它一路上说了些什么」。原始对话留在子 Agent 那边，随它一起被扔掉。
 */
export interface SubagentResult {
  id: string
  task: string
  /** 跑完且没被上限打断、也没报错 */
  ok: boolean
  /** 它自己那句收尾话，截断到 SUMMARY_BUDGET */
  summary: string
  changes: FileChange[]
  /** 用过的工具名，按调用顺序去重 */
  tools: string[]
  rounds: number
  tokens: number
  ms: number
  /** 不 ok 时说清是为什么：撞了哪条上限、还是循环报了错 */
  note: string | null
  /** 开始与结束的时刻。自检用它证明两个子 Agent 的区间真的重叠 */
  startedAt: number
  endedAt: number
}

/** 合并时对一个文件的裁决 */
export interface MergeEntry {
  path: string
  /** 谁改的。同一路径被多个子 Agent 改到时这里不止一个 */
  by: string[]
  action: 'apply' | 'conflict'
  why: string
}

export interface MergePlan {
  entries: MergeEntry[]
  /** 真的落盘的那几条，path → 内容 */
  applied: Map<string, string>
  conflicts: MergeEntry[]
}

/** 子 Agent 的默认预算：比主会话紧得多，理由写在 run.ts */
export const SUBAGENT_LIMITS: Partial<RunLimits> = {
  maxRounds: 4,
  maxMs: 60_000,
  maxTokens: 20_000,
}

/** 一份回执里那句收尾话最多带多少字符回来 */
export const SUMMARY_BUDGET = 400

/** 一次最多派几个。不是性能上限，是「你还看得懂」的上限，理由写在 tool.ts */
export const MAX_AGENTS = 4

/**
 * 派单文本的前缀。它写在子 Agent 那条 user 消息的最前面。
 *
 * 不只是给离线剧本认的：真实模式下它同样有用——子 Agent 看到的第一句话
 * 必须让它知道「这是一张一次性的派单，不是一段正在进行的对话」，
 * 否则它会去追问上一轮的上下文，而那个上下文根本不存在。
 */
export const TASK_PREFIX = '【派单】'

/** 工位号的形状。它要当目录名用，所以不许有斜杠、点与空格 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/
