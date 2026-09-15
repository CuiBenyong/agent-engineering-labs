/**
 * 模型网关的接口。★ D1 定稿，之后二十天逐字不变。
 *
 * 只有一个方法，而且只有流式的那一种：非流式接口在 Coding Agent 里没有用处，
 * 多留一个方法就多一处要在二十一天里维护的分支。
 */
import type { Message, ToolDef } from '../kernel/types.js'

export interface ChatRequest {
  messages: Message[]
  tools?: ToolDef[]
  signal?: AbortSignal
}

/** 网关吐出来的原始增量。它是"报文形状"，不是"业务语义" */
export type StreamDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens: number }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'other' }

export interface ChatProvider {
  /** 用于日志与自检，例如 gateway 或 mock */
  readonly id: string
  readonly model: string
  stream(req: ChatRequest): AsyncIterable<StreamDelta>
}
