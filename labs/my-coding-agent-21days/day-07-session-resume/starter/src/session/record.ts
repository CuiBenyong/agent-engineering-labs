/**
 * 把一轮的事件边录边写。本天新增。
 *
 * 它是一个「透明包装」：把循环吐出来的 AgentEvent 原样传给渲染层，路过的时候
 * 顺手写日志。这样做的两个好处：
 *   1. 循环与渲染层都不知道有日志这件事——加持久化不需要动它们任何一行
 *   2. 落盘的时机是「事件发生时」而不是「一轮结束时」。中途被杀掉，前面的事件都在，
 *      这正是我们敢说「最后一行写坏是常态」的原因：常态就该被处理，不该被避免
 *
 * 顺序也是有意的：每次拿到事件，先把消息数组里新增的那几条落盘，再写这条事件。
 * 于是日志里的顺序天然是「助手消息 → 它的 tool_end → 工具结果消息」，
 * 读日志的人不用在脑子里重排。
 */
import type { AgentEvent, Message } from '../kernel/types.js'
import type { SessionLog } from './log.js'

export async function* recordTurn(
  log: SessionLog,
  messages: Message[],
  events: AsyncIterable<AgentEvent>
): AsyncGenerator<AgentEvent> {
  await log.flushMessages(messages)

  for await (const event of events) {
    // TODO(5)：在这里先刷一次消息（await log.flushMessages(messages)）。
    // 少了这一句，一轮里新增的消息会全部攒到最后才落盘，于是日志里的顺序变成
    // 「先所有事件、后所有消息」——读日志的人得在脑子里重排，而且中途被杀掉时
    // 那一轮的消息一条都没留下。正确的顺序是「助手消息 → 它的 tool_end → 工具结果消息」。
    switch (event.type) {
      case 'tool_end':
        // 只记 meta 与回灌文本的长度信息：正文已经作为一条 tool 消息记过了
        await log.append({ type: 'tool_end', id: event.id, result: event.result })
        break
      case 'usage':
        await log.append({
          type: 'usage',
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          cachedTokens: event.cachedTokens,
        })
        break
      case 'error':
        // 退避重试的提示（retryable 为真）不入日志：它是过程噪音，不是发生过的事实
        if (!event.retryable) await log.append({ type: 'error', message: event.message })
        break
      default:
        break
    }
    yield event
  }

  // 收尾再刷一次：最后一条助手消息是在 done 事件之前 push 的，但 done 之后
  // 循环还可能补一条（例如上限说明），所以这一次不能省
  await log.flushMessages(messages)
}
