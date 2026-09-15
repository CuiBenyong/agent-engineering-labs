/**
 * 全课的三套协议：消息、工具、事件。
 *
 * ★ 这个文件在 D1 定稿，之后二十天逐字不变（由 scripts/check-mca-consistency.sh 闸住）。
 * 今天只用到其中一小半（Message 与 AgentEvent 的 text / done），
 * 工具相关的类型先摆在这里，是为了让后面每天加能力时不必回来改地基。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** 消息内容的两种形态：纯文本用 string，多模态用数组（D19 才会用到数组） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string }

export interface Message {
  role: Role
  content: string | ContentPart[]
  /** role 为 assistant 且模型要求调工具时出现 */
  toolCalls?: ToolCall[]
  /** role 为 tool 时必填，指回 ToolCall.id */
  toolCallId?: string
  /** role 为 tool 时必填，工具名 */
  name?: string
}

export interface ToolCall {
  id: string
  name: string
  /** 未解析的 JSON 文本：它是一片片拼起来的，解析失败是常态而不是异常 */
  args: string
}

export interface ToolResult {
  ok: boolean
  /** 回灌给模型的文本。超长要截断，并在末尾注明截掉了多少 */
  content: string
  /** 只给终端渲染看，不回灌给模型 */
  meta?: Record<string, unknown>
}

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  log(line: string): void
}

export interface ToolDef {
  name: string
  description: string
  /** 传给模型的 JSON Schema，手写对象，不引 schema 库 */
  parameters: Record<string, unknown>
  /** 只读工具不触发审批（D5 会用到这个字段） */
  readOnly: boolean
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>
}

/**
 * 循环对外发出的语义事件。
 *
 * 注意它和 providers/types.ts 里的 StreamDelta 是两回事：
 * StreamDelta 是"网关说了什么"，AgentEvent 是"循环发生了什么"。
 * 渲染层只订阅 AgentEvent，永远不碰 StreamDelta——这层分界是 D2 的重点。
 */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; id: string; result: ToolResult }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens: number }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'done'; reason: 'stop' | 'tool_calls' | 'aborted' | 'error' }

/** 把 Message.content 统一取成纯文本，方便渲染与日志 */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : `[图片 ${part.mediaType}]`))
    .join('')
}
