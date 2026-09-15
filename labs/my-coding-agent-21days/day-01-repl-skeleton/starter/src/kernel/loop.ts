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

  // TODO(4) 把网关的 StreamDelta 翻译成 AgentEvent。
  //
  // 要点：
  //   1. for await 拿 provider.stream({ messages, tools, signal }) 的每一片
  //      （registry 为空时 tools 传 undefined，别传空数组）
  //   2. text 片：累加到 assistantText，并 yield { type: 'text', delta }
  //   3. usage 片：原样转成 usage 事件
  //   4. finish 片：记下 finish 供最后的 done 事件用
  //   5. tool_call 片：今天还没有工具层，先忽略（D3 接上）
  //   6. 整段包在 try/catch 里：出错时 yield 一条 error 事件再 yield done，
  //      不要把异常抛给调用方——渲染层只认事件
  void provider
  void registry
  void signal
  void finish

  // 把这一轮的回答写回消息数组，下一轮才有上下文
  if (assistantText) messages.push({ role: 'assistant', content: assistantText })
  yield { type: 'done', reason: finish }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
