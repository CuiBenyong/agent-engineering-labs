/**
 * Agent Loop。来自 D4（内容与 D3 相同），本天只加了一处：执行工具之前先过审批门。
 * 那一处只有五行，因为门被做成了「返回一条工具结果就等于不执行」——
 * 循环不需要知道审批是怎么问的，也不需要为拒绝准备任何错误路径。
 *
 * 原 D3 说明：来自 D2，本天第一次变成真正的「循环」：
 *   1. 归并流式工具调用分片（交给 ToolCallAccumulator）
 *   2. 执行工具，把结果作为一条 tool 消息追加回消息数组，然后再发一次
 *   3. 一圈圈转，直到模型不再要工具
 *
 * 三条不变量，后面十八天都靠它们：
 *   - 助手消息必须带上它请求的工具调用（toolCalls），否则下一轮的工具结果指不回去，
 *     大多数网关会直接报错
 *   - 每个工具调用必须有且只有一条对应的 tool 消息，哪怕它失败了
 *   - 工具失败不抛异常，而是变成一条 ok 为 false 的结果回灌给模型（D6 展开）
 */
import type { AgentEvent, Message, ToolContext } from './types.js'
import type { ChatProvider } from '../providers/types.js'
import type { ToolRegistry } from './tools.js'
import { ToolCallAccumulator } from './tool-calls.js'
import { passGate, type GateOptions } from './approval.js'

/** 一轮对话最多转几圈。完整的三条上限（轮数、时长、花费）是 D6 的内容 */
export const MAX_ROUNDS = 8

export interface RunOptions {
  provider: ChatProvider
  registry: ToolRegistry
  messages: Message[]
  /** 工具的工作目录：本课统一是沙盒仓库 work/repo */
  cwd: string
  signal?: AbortSignal
  log?: (line: string) => void
  /** 审批门。不传就没有门（本课只在自检的个别用例里这么做） */
  gate?: GateOptions
}

export async function* run(options: RunOptions): AsyncGenerator<AgentEvent> {
  const { provider, registry, messages, cwd, signal } = options
  const ctx: ToolContext = {
    cwd,
    signal: signal ?? new AbortController().signal,
    log: options.log ?? (() => {}),
  }

  // 「本轮放行」的记忆只在这一次 run 里有效：用户说「这次可以」，
  // 指的是这一次任务，不是这个会话的余生
  options.gate?.state.onceAllowed.clear()

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    let assistantText = ''
    let finish: 'stop' | 'tool_calls' = 'stop'
    const calls = new ToolCallAccumulator()

    try {
      for await (const delta of provider.stream({
        messages,
        tools: registry.size > 0 ? registry.list() : undefined,
        signal,
      })) {
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
          case 'tool_call':
            // 只累加不处理：一次调用的参数要等全部分片到齐才是合法 JSON
            calls.push(delta)
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
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        if (assistantText) messages.push({ role: 'assistant', content: assistantText })
        yield { type: 'done', reason: 'aborted' }
        return
      }
      if (assistantText) messages.push({ role: 'assistant', content: assistantText })
      yield { type: 'error', message: describeError(error), retryable: isRetryable(error) }
      yield { type: 'done', reason: 'error' }
      return
    }

    // 判据用 finish 与「有没有归并出调用」的并集：实测有模型在 finish 上报 stop
    // 却仍然给了工具分片，只信一个字段会把这一轮当成说完了
    const pending = finish === 'tool_calls' || calls.size > 0 ? calls.drain() : []
    if (pending.length === 0) {
      if (assistantText) messages.push({ role: 'assistant', content: assistantText })
      yield { type: 'done', reason: 'stop' }
      return
    }

    messages.push({ role: 'assistant', content: assistantText, toolCalls: pending })
    for (const call of pending) {
      yield { type: 'tool_start', call }
      // 审批门：拿到一条结果就等于「不执行」，拿到 null 才去真的执行。
      // 暂停发生在这一行的 await 里——它是循环的一部分，不是异常路径。
      const tool = registry.get(call.name)
      const blocked = options.gate && tool ? await passGate(call, tool, options.gate) : null
      const result = blocked ?? (await registry.execute(call, ctx))
      yield { type: 'tool_end', id: call.id, result }
      // 失败也要追加：少一条 tool 消息，下一轮请求就不合法
      messages.push({
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
        name: call.name,
      })
      if (signal?.aborted) {
        yield { type: 'done', reason: 'aborted' }
        return
      }
    }
  }

  yield {
    type: 'error',
    message: `已经转了 ${MAX_ROUNDS} 圈还没结束，先停下来。检查一下是不是在反复调同一个工具。`,
    retryable: false,
  }
  yield { type: 'done', reason: 'error' }
}

/**
 * 可重试判定只看一个约定：错误对象上有没有 retryable 为 true。
 * 网关层的 StreamTruncatedError 与 RateLimitError 都带这个字段。
 */
function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
