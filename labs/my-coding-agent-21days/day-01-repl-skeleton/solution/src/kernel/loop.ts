/**
 * Agent Loop。今天只有一圈：把消息交给网关，把网关的增量翻译成语义事件。
 *
 * 后面每天都在这个文件上加东西：D3 加工具执行、D5 加审批、D6 加重试与取消、
 * D12 加压缩。所以它允许扩写，但每天的 README 都要写清「本天改了什么」。
 */
import type { AgentEvent, Message } from './types.js'
import type { ChatProvider } from '../providers/types.js'
import type { ToolRegistry } from './tools.js'

export interface RunOptions {
  provider: ChatProvider
  registry: ToolRegistry
  messages: Message[]
  signal?: AbortSignal
}

/**
 * 跑一轮对话，产出语义事件流。
 * 注意产出的是 AgentEvent 而不是 StreamDelta：调用方（渲染层、会话层、以后的
 * 自动化脚本）只需要知道「发生了什么」，不需要知道网关的报文长什么样。
 */
export async function* run(options: RunOptions): AsyncGenerator<AgentEvent> {
  const { provider, registry, messages, signal } = options
  let assistantText = ''
  let finish: 'stop' | 'tool_calls' = 'stop'

  try {
    for await (const delta of provider.stream({
      messages,
      tools: registry.size > 0 ? registry.list() : undefined,
      signal,
    })) {
      switch (delta.type) {
        case 'text':
          assistantText += delta.text
          yield { type: 'text', delta: delta.text }
          break
        case 'usage':
          yield {
            type: 'usage',
            promptTokens: delta.promptTokens,
            completionTokens: delta.completionTokens,
            cachedTokens: delta.cachedTokens,
          }
          break
        case 'finish':
          finish = delta.reason === 'tool_calls' ? 'tool_calls' : 'stop'
          break
        case 'tool_call':
          // 今天还没有工具层：收到工具分片说明剧本或网关超前了，先忽略，D3 接上。
          break
      }
    }
  } catch (error) {
    yield { type: 'error', message: describeError(error), retryable: false }
    yield { type: 'done', reason: 'error' }
    return
  }

  // 把这一轮的回答写回消息数组，下一轮才有上下文
  if (assistantText) messages.push({ role: 'assistant', content: assistantText })
  yield { type: 'done', reason: finish }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
