// W3 的共享状态类型：D15 定稿，D16 / D17 / D18 / D21 直接照抄这一份，不增删字段。
// 一个字段只由一天写入，注释里标了是谁写的——这样六天下来状态不会长成一团乱麻。

/** 模型发出的一次工具调用请求。沿用 D2 的形状：arguments 是 JSON 文本，不是对象。 */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
}

/** 沿用 D2 / D5 定的 Message 形状，跨周保持一致，图里传的还是这一份。 */
export type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * 多模态占位：字段是 D15 占好的，今天（D18）第一次真的让它穿过摘要与检查点。
 * 今天仍然不接图像模型——只保证这条通道在压缩和持久化两道工序里都原样过去。
 */
export interface Attachment {
  id: string
  kind: 'image' | 'audio' | 'file'
  /** 引用而不是内容：图状态会被整份序列化进检查点，塞 base64 会让每一次写检查点都变慢、变贵 */
  ref: string
  /** 附件的一句话描述。刻意不叫 summary：AgentState.summary 是「早期消息的摘要」，
   *  同一个状态类型里同名不同义最容易读错 */
  caption?: string
}

/** 一件可以被单独派出去、单独失败、单独重试的活。D17 的 Planner 会一次产出好几个。 */
export interface Task {
  id: string
  goal: string
  result?: string
  /** 已用的工具调用次数，上限见 D17 的 toolBudget（5 次） */
  toolCalls: number
  status: 'pending' | 'running' | 'done' | 'failed'
}

/** 图的共享状态。每个节点读它的全部、只写自己那几个字段。 */
export interface AgentState {
  /** 对话历史，用 concat 累加 */
  messages: Message[]
  /** D16 写入：order_lookup | refund_draft | smalltalk */
  route?: string
  /** D16 写入：为什么这么判，事后排查全靠它 */
  routingReason?: string
  /** D17 写入：并行子任务，配 concat reducer */
  workspace: Task[]
  /** D17 写入：Critic 已经打回几次 */
  reviewRounds: number
  /** D18 写入：早期消息的摘要。它是派生数据，原文另有出处——不要拿它当唯一真相 */
  summary?: string
  /** D18 写入：多模态占位，摘要节点必须跳过它 */
  attachments: Attachment[]
  /** D17 写入：预算或重试耗尽时的降级标记 */
  degraded: boolean
}

/** 把一条 Message 压成一行可读文本，只用于打印状态流动。 */
export function preview(message: Message): string {
  const text = typeof message.content === 'string' ? message.content : '(工具调用)'
  return `${message.role}: ${text.slice(0, 42)}`
}
