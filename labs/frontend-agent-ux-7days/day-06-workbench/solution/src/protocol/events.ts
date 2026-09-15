/**
 * 【冻结文件 · D1 定稿】D2–D7 逐字复制，不要就地修改。
 * 改动后必须跑 bash scripts/check-feux-consistency.sh 复验一致性。
 *
 * 本课采用的 AG-UI 事件子集（18 个）。事件名与字段名逐字取自上游
 * sdks/typescript/packages/core/src/events.ts（2026-09-14 拉取）。
 *
 * 注意：上游的 THINKING_* 系列已标记 @deprecated（1.0.0 移除），
 * 本课一律用 REASONING_* 系列。网上不少教程还在写旧名字。
 */

/** 一次运行的唯一标识。thread 是会话，run 是会话里的一次执行。 */
export type RunIds = {
  threadId: string
  runId: string
}

/**
 * 所有事件共有的字段。
 *
 * 关键设计：这里刻意允许未知字段（见 decode.ts 的 toEvent），
 * 对应上游 schema 的 .passthrough()。协议还在演进，上游随时会加新事件，
 * 前端遇到不认识的东西必须忽略而不是崩溃，否则后端每升级一次就会打挂一批前端。
 */
export type BaseEvent = {
  type: string
  timestamp?: number
  /** 上游原始事件，调试用 */
  rawEvent?: unknown
  metadata?: Record<string, unknown>
  /** 归属的子 Agent 运行；D6 才用到，前五天忽略即可 */
  subagentRunId?: string
}

// ---------- 运行生命周期 ----------

export type RunStartedEvent = BaseEvent & {
  type: 'RUN_STARTED'
  threadId: string
  runId: string
  parentRunId?: string
}

/**
 * 运行结束。outcome 是本课第三天的重点：
 * 它区分「跑完了」和「跑到一半停下来等人做决定」两种结束。
 */
export type RunFinishedEvent = BaseEvent & {
  type: 'RUN_FINISHED'
  threadId: string
  runId: string
  result?: unknown
  outcome?: RunOutcome
}

/** 成功收尾，或因为需要人来做决定而中断。D3 会用到 interrupt 分支。 */
export type RunOutcome =
  | { type: 'success'; result?: unknown }
  | { type: 'interrupt'; interruptId: string; reason?: string; payload?: unknown }

export type RunErrorEvent = BaseEvent & {
  type: 'RUN_ERROR'
  message: string
  code?: string
}

export type StepStartedEvent = BaseEvent & {
  type: 'STEP_STARTED'
  stepName: string
}

export type StepFinishedEvent = BaseEvent & {
  type: 'STEP_FINISHED'
  stepName: string
}

// ---------- 文本消息（三段式）----------

export type TextMessageRole = 'assistant' | 'user' | 'system' | 'tool' | 'developer'

export type TextMessageStartEvent = BaseEvent & {
  type: 'TEXT_MESSAGE_START'
  messageId: string
  role: TextMessageRole
  name?: string
}

export type TextMessageContentEvent = BaseEvent & {
  type: 'TEXT_MESSAGE_CONTENT'
  messageId: string
  /** 增量片段，不是完整文本。前端负责按 messageId 累加 */
  delta: string
}

export type TextMessageEndEvent = BaseEvent & {
  type: 'TEXT_MESSAGE_END'
  messageId: string
}

// ---------- 工具调用（D3）----------

export type ToolCallStartEvent = BaseEvent & {
  type: 'TOOL_CALL_START'
  toolCallId: string
  toolCallName: string
  parentMessageId?: string
}

export type ToolCallArgsEvent = BaseEvent & {
  type: 'TOOL_CALL_ARGS'
  toolCallId: string
  /** 参数是流式拼出来的 JSON 字符串片段，拼完之前不能 JSON.parse */
  delta: string
}

export type ToolCallEndEvent = BaseEvent & {
  type: 'TOOL_CALL_END'
  toolCallId: string
}

export type ToolCallResultEvent = BaseEvent & {
  type: 'TOOL_CALL_RESULT'
  messageId: string
  toolCallId: string
  content: string
  role?: 'tool'
}

// ---------- 推理过程（D4）----------

export type ReasoningStartEvent = BaseEvent & {
  type: 'REASONING_START'
  messageId: string
}

export type ReasoningMessageContentEvent = BaseEvent & {
  type: 'REASONING_MESSAGE_CONTENT'
  messageId: string
  delta: string
}

export type ReasoningEndEvent = BaseEvent & {
  type: 'REASONING_END'
  messageId: string
}

// ---------- 共享状态（D4）----------

export type StateSnapshotEvent = BaseEvent & {
  type: 'STATE_SNAPSHOT'
  /** 整份状态，用于打底与补丁失败后的恢复 */
  snapshot: unknown
}

export type StateDeltaEvent = BaseEvent & {
  type: 'STATE_DELTA'
  /** JSON Patch（RFC 6902）操作数组 */
  delta: JsonPatchOperation[]
}

export type JsonPatchOperation = {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
  path: string
  value?: unknown
  from?: string
}

// ---------- 子 Agent（D6）----------

export type SubagentStartedEvent = BaseEvent & {
  type: 'SUBAGENT_STARTED'
  subagentRunId: string
  name: string
  description?: string
  parentToolCallId?: string
}

export type SubagentFinishedEvent = BaseEvent & {
  type: 'SUBAGENT_FINISHED'
  subagentRunId: string
  result?: unknown
}

// ---------- 扩展（D5）----------

export type CustomEvent = BaseEvent & {
  type: 'CUSTOM'
  name: string
  value: unknown
}

/** 本课认识的全部事件。注意：解码器不会因为收到这之外的类型而报错。 */
export type AgentEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ReasoningStartEvent
  | ReasoningMessageContentEvent
  | ReasoningEndEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | CustomEvent

export const KNOWN_EVENT_TYPES = [
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'STEP_STARTED',
  'STEP_FINISHED',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'REASONING_START',
  'REASONING_MESSAGE_CONTENT',
  'REASONING_END',
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'SUBAGENT_STARTED',
  'SUBAGENT_FINISHED',
  'CUSTOM',
] as const

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number]

const KNOWN = new Set<string>(KNOWN_EVENT_TYPES)

/**
 * 类型守卫：这条事件是不是本课认识的类型。
 *
 * 用途不是「过滤掉坏数据」，而是让 TypeScript 在 switch 里收窄类型。
 * 返回 false 的事件应当被忽略并在开发模式下打日志，绝不能 throw。
 */
export function isKnownEvent(event: BaseEvent): event is AgentEvent {
  return KNOWN.has(event.type)
}
