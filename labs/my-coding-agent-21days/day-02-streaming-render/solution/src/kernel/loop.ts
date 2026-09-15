/**
 * Agent Loop。来自 D1，本天改了两处：
 *   1. 把网关的错误分成「可重试」与「不可重试」两类，作为 error 事件的一个字段透出去
 *      （怎么重试是 D6 的事，今天只负责分类，不然渲染层没法决定该说什么）
 *   2. 每片之间检查取消信号：用户打断时立刻收尾，并把已经收到的文本留在消息数组里
 *
 * 后面每天都在这个文件上加东西：D3 加工具执行、D5 加审批、D6 加重试与取消链路、
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
 *
 * 注意产出的是 AgentEvent 而不是 StreamDelta：调用方（渲染层、会话层、以后的
 * 自动化脚本）只需要知道「发生了什么」，不需要知道网关的报文长什么样。
 * 今天这条分界第一次真的付了利息——渲染层要处理断流与打断两种收尾，
 * 而它们一个来自网关、一个来自键盘，在事件层被统一成了 error 与 done。
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
      // 打断检查放在每一片之间：这是流式的一个额外好处——有很多次可以停下来的机会
      if (signal?.aborted) {
        if (assistantText) messages.push({ role: 'assistant', content: assistantText })
        yield { type: 'done', reason: 'aborted' }
        return
      }

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
    if (signal?.aborted) {
      if (assistantText) messages.push({ role: 'assistant', content: assistantText })
      yield { type: 'done', reason: 'aborted' }
      return
    }
    // 已经收到的文本不丢：断流不是「这一轮没发生」，是「这一轮没说完」
    if (assistantText) messages.push({ role: 'assistant', content: assistantText })
    yield { type: 'error', message: describeError(error), retryable: isRetryable(error) }
    yield { type: 'done', reason: 'error' }
    return
  }

  // 把这一轮的回答写回消息数组，下一轮才有上下文
  if (assistantText) messages.push({ role: 'assistant', content: assistantText })
  yield { type: 'done', reason: finish }
}

/**
 * 可重试判定只看一个约定：错误对象上有没有 retryable 为 true。
 * 网关层的 StreamTruncatedError 与 RateLimitError 都带这个字段，
 * 业务错误（比如 400 参数错）不带——重试它一百次也是同一个结果。
 */
function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
