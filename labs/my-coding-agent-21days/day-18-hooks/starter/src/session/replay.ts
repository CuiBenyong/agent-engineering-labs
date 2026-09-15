/**
 * 重放：把事件序列变回一个消息数组。本天新增，是纯函数，不碰文件系统。
 *
 * 全文最重要的一句话：**只有 message 事件参与重建，其余三种一条都不参与。**
 *
 * 这一点值得多说两句，因为它反直觉。tool_end 事件里明明有工具结果，为什么不用它来
 * 重建那条 tool 消息？因为工具结果**已经**以一条 role 为 tool 的消息落进日志了——
 * 那才是要发给模型的东西。tool_end 里额外记的是耗时、字符数、有没有被截断、
 * 是被审批门还是打转检测挡下来的，这些是**给人看的**：审计、算成本、事后复盘。
 *
 * 两类信息分开记的收益很直接：
 *   - 重建逻辑只有一条规则，不会因为「哪个字段更权威」而分叉
 *   - 想给终端加一列统计，只要多记一种非 message 事件，重放代码一行都不用改
 *
 * 反过来，如果你把两类信息混在一种事件里，第十二天做上下文压缩时会立刻付账：
 * 你要在同一个对象上区分「这部分要发给模型」和「这部分只给人看」。
 */
import type { Message } from '../kernel/types.js'
import type { SessionEvent } from './log.js'

export interface Replayed {
  /** 重建出来的消息数组，可以直接接着往里 push 下一条用户消息 */
  messages: Message[]
  /** 参与重建的事件数 */
  replayed: number
  /** 只用于展示与审计、没有参与重建的事件数 */
  skipped: number
  /** 从日志里累计出的用量，接着算上限用 */
  tokens: number
  /** 这条会话是从哪个会话的哪一步分叉来的 */
  forkedFrom: { from: string; atSeq: number } | null
}

export function replay(events: SessionEvent[]): Replayed {
  const messages: Message[] = []
  let replayed = 0
  let skipped = 0
  let tokens = 0
  let forkedFrom: Replayed['forkedFrom'] = null

  for (const event of events) {
    switch (event.type) {
      case 'message':
        messages.push(event.message)
        replayed += 1
        break
      case 'usage':
        tokens += event.promptTokens + event.completionTokens
        skipped += 1
        break
      case 'fork':
        forkedFrom = { from: event.from, atSeq: event.atSeq }
        skipped += 1
        break
      default:
        // tool_end 与 error：只给人看
        skipped += 1
    }
  }

  return { messages, replayed, skipped, tokens, forkedFrom }
}

/**
 * 可以在哪些位置分叉。
 *
 * 判据是「这一步之后对话是完整的」：**只有用户消息与不带工具调用的助手消息之后
 * 才能分叉。** 在一条带工具调用的助手消息之后截断，会得到一个「请求了工具却没有
 * 结果」的消息数组，下一轮请求直接不合法；在一条工具结果中间截断同理。
 *
 * 所以分叉点不是「任意一行」，而是「任意一个干净的边界」。终端把这些边界列给用户，
 * 比让他自己数行号靠得住。
 */
export interface ForkPoint {
  seq: number
  role: 'user' | 'assistant'
  /** 一行摘要，给终端列出来 */
  preview: string
}

export function forkPoints(events: SessionEvent[], previewChars = 28): ForkPoint[] {
  const points: ForkPoint[] = []
  for (const event of events) {
    if (event.type !== 'message') continue
    const message = event.message
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.role === 'assistant' && message.toolCalls?.length) continue
    const text = typeof message.content === 'string' ? message.content : '[多模态内容]'
    points.push({
      seq: event.seq,
      role: message.role,
      preview: text.length > previewChars ? `${text.slice(0, previewChars)}…` : text,
    })
  }
  return points
}
