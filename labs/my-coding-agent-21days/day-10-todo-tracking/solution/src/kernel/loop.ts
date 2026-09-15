/**
 * Agent Loop。来自 D9（D7–D9 都没动它），本天加了一件事：**停滞检测**。
 *
 * 位置很讲究：紧跟在三条硬上限之后，也就是每一轮开始之前。理由是它和硬上限
 * 是同一类东西——都在问「还该不该再转一圈」，只是判据不同：
 * 上限看的是资源（轮数、时长、token），停滞看的是**进展**（清单有没有动）。
 *
 * 干预分两级，和第六天的打转打断同一条思路——先给机会，再抬头：
 *   nudge  以 user 角色回灌一条提醒，这一轮照常继续
 *   stop   停下这一轮，走和硬上限完全一样的出口
 *
 * 提醒事件复用 `error` 加 `retryable: true`，**没有给 AgentEvent 加新类型**。
 * 这是第五天那条裁定的延续：渲染层要知道的只是「循环接下来还会转一圈」，
 * 而这正是 retryable 这一位的语义。为了在屏幕上多打一种前缀去改协议层，不划算。
 *
 * 原 D6 说明：本天是它到目前为止改动最大的一次，加了四件事：
 *   1. 网关调用包上退避重试（retry.ts），并把「正在退避」当成一条可重试错误事件发出去
 *   2. 三条硬上限换掉了原来那个孤零零的 MAX_ROUNDS（limits.ts）
 *   3. 每个工具调用先过打转检测（repeat.ts），命中就回灌一条说明而不执行
 *   4. 取消（signal）在三个位置各查一次：分片之间、工具执行前、工具执行后
 *
 * 一条今天定下的口径，后面十五天都按它写：
 * **AgentEvent 里 error 事件的 retryable 表示「循环接下来会自己再试一次」，
 * 不表示「这个错误理论上可不可重试」。** 渲染层就靠这一位决定是打一行「正在重试」
 * 还是打一行「这一轮失败了」。
 *
 * 原 D5 说明：执行工具之前先过审批门，那一处只有五行，因为门被做成了
 * 「返回一条工具结果就等于不执行」。
 *
 * 三条不变量，从 D3 起没变过：
 *   - 助手消息必须带上它请求的工具调用（toolCalls），否则下一轮的工具结果指不回去
 *   - 每个工具调用必须有且只有一条对应的 tool 消息，哪怕它失败了、被拒了、被打断了
 *   - 工具失败不抛异常，而是变成一条 ok 为 false 的结果回灌给模型
 */
import type { AgentEvent, Message, ToolCall, ToolContext, ToolResult } from './types.js'
import type { ChatProvider } from '../providers/types.js'
import type { ToolRegistry } from './tools.js'
import { ToolCallAccumulator } from './tool-calls.js'
import { passGate, type GateOptions } from './approval.js'
import { streamWithRetry, type RetryOptions } from './retry.js'
import { diagnoseStreamError } from './errors.js'
import { LimitTracker, type RunLimits } from './limits.js'
import { RepeatDetector } from './repeat.js'
import { StallDetector, type StallLimits } from '../todo/stall.js'
import type { TodoList } from '../todo/list.js'

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
  /** 三条硬上限，不传用 DEFAULT_LIMITS */
  limits?: Partial<RunLimits>
  /** 退避重试参数，不传用 retry.ts 里的缺省值 */
  retry?: RetryOptions
  /** 任务清单。传了才做停滞检测——没有清单就没有「进展」这个度量 */
  todos?: TodoList
  /** 停滞阈值，不传用 DEFAULT_STALL */
  stall?: Partial<StallLimits>
}

export async function* run(options: RunOptions): AsyncGenerator<AgentEvent> {
  const { provider, registry, messages, cwd, signal } = options
  const ctx: ToolContext = {
    cwd,
    signal: signal ?? new AbortController().signal,
    log: options.log ?? (() => {}),
  }

  const tracker = new LimitTracker(options.limits)
  const repeats = new RepeatDetector()
  const stalls = new StallDetector(options.stall)
  options.gate?.state.onceAllowed.clear()

  // 退避是在 await 里发生的，而回调里不能 yield，所以先攒进这个队列，
  // 下一次有机会 yield 的时候再倒出来
  const notices: string[] = []
  const retry: RetryOptions = {
    ...options.retry,
    onRetry: (info) => {
      notices.push(
        `网关这次没成功（${info.message}），等 ${info.waitMs}ms 再试第 ${info.attempt + 1} 次`
      )
      options.retry?.onRetry?.(info)
    },
  }

  for (;;) {
    const stop = tracker.beginRound()
    if (stop) {
      // 硬上限触发时也要给模型留一条记录：下一次用户接着说，它才知道上次为什么断的
      messages.push({ role: 'assistant', content: stop.message })
      yield { type: 'error', message: stop.message, retryable: false }
      yield { type: 'done', reason: 'error' }
      return
    }

    // 停滞检测紧跟硬上限：两者都在问「还该不该再转一圈」，只是判据不同
    const todos = options.todos
    const stalled = todos
      ? stalls.check(tracker.stats.rounds, todos.revision, todos.maxReopen)
      : null
    if (stalled?.action === 'stop') {
      messages.push({ role: 'assistant', content: stalled.message })
      yield { type: 'error', message: stalled.message, retryable: false }
      yield { type: 'done', reason: 'error' }
      return
    }
    if (stalled) {
      // user 角色而不是 assistant：assistant 消息会被它当成自己说过的话，
      // 于是它很可能顺着原来那条思路继续；user 消息才是「有人在催」
      messages.push({ role: 'user', content: stalled.message })
      yield { type: 'error', message: stalled.message, retryable: true }
    }

    let assistantText = ''
    let finish: 'stop' | 'tool_calls' = 'stop'
    let deltas = 0
    const calls = new ToolCallAccumulator()

    try {
      for await (const delta of streamWithRetry(
        provider,
        {
          messages,
          tools: registry.size > 0 ? registry.list() : undefined,
          signal,
        },
        retry
      )) {
        while (notices.length > 0) {
          yield { type: 'error', message: notices.shift() as string, retryable: true }
        }
        deltas += 1
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
            calls.push(delta)
            break
          case 'usage':
            tracker.addUsage(delta.promptTokens, delta.completionTokens)
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
      while (notices.length > 0) {
        yield { type: 'error', message: notices.shift() as string, retryable: true }
      }
      if (assistantText) messages.push({ role: 'assistant', content: assistantText })
      if (signal?.aborted) {
        yield { type: 'done', reason: 'aborted' }
        return
      }
      // 走到这里说明 streamWithRetry 已经放弃了：要么不该重试，要么次数用完了
      yield { type: 'error', message: diagnoseStreamError(error, deltas).message, retryable: false }
      yield { type: 'done', reason: 'error' }
      return
    }
    while (notices.length > 0) {
      yield { type: 'error', message: notices.shift() as string, retryable: true }
    }

    const pending = finish === 'tool_calls' || calls.size > 0 ? calls.drain() : []
    if (pending.length === 0) {
      if (assistantText) messages.push({ role: 'assistant', content: assistantText })
      yield { type: 'done', reason: 'stop' }
      return
    }

    messages.push({ role: 'assistant', content: assistantText, toolCalls: pending })
    for (const call of pending) {
      yield { type: 'tool_start', call }
      const result = await settle(call, options, ctx, repeats)
      yield { type: 'tool_end', id: call.id, result }
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
}

/**
 * 一次工具调用要过的三道判断，顺序是有讲究的：
 *   打转检测 → 审批门 → 真的执行
 * 打转排在最前面，因为一个正在打转的调用不该去打扰用户审批第三遍。
 */
async function settle(
  call: ToolCall,
  options: RunOptions,
  ctx: ToolContext,
  repeats: RepeatDetector
): Promise<ToolResult> {
  if (repeats.tripped(call)) {
    return { ok: false, content: repeats.note(call), meta: { blockedBy: 'repeat' } }
  }
  const tool = options.registry.get(call.name)
  const blocked = options.gate && tool ? await passGate(call, tool, options.gate) : null
  if (blocked) return blocked
  return options.registry.execute(call, ctx)
}
