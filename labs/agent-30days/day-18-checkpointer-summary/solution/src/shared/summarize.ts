// 摘要节点的全部业务逻辑：什么时候触发、切在哪、留什么、以及绝对不碰什么。
//
// 和 D6 的上下文压缩不是同一件事：D6 压的是**发给模型的那一份请求**，压完就发走了；
// 今天压的是**图状态本身**，压完的结果会被 checkpointer 原样持久化下去，
// 从检查点恢复的每一次执行读到的都是这一份。所以这里丢掉的东西是永久丢掉的。

import { callModel } from '../infra/model'
import type { Message } from './state'

/** 触发阈值一：消息条数。超过 20 条就压。 */
export const MAX_MESSAGES = 20

/** 触发阈值二：估算 token 数。按 D6 定的 1 字符 ≈ 1 token 保守高估，超过 8000 就压。 */
export const MAX_TOKENS = 8000

/** 保留最近 6 条原文不动。模型最依赖刚发生的事，这 6 条一个字都不能改。 */
export const KEEP_RECENT = 6

/** 沿用 D6 的估法：一个字符算一个 token。故意高估——低估会让阈值永远触发不了。 */
export function estimateTokens(messages: Message[]): number {
  return messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 40),
    0
  )
}

/** 两个阈值任意一个到就压。返回命中的是哪一条，日志里要能看出来。 */
export function needsSummary(messages: Message[]): string | null {
  if (messages.length > MAX_MESSAGES) return `条数 ${messages.length} 超过 ${MAX_MESSAGES}`
  const tokens = estimateTokens(messages)
  if (tokens > MAX_TOKENS) return `估算 ${tokens} token 超过 ${MAX_TOKENS}`
  return null
}

/**
 * 切口对齐到一轮的开头。D6 已经讲过这条：切在 assistant 的 tool_calls 与对应的 tool
 * 结果之间，下一次请求就出现「有调用没结果」的悬空消息，多数厂商直接返回 400。
 * 所以只能往前挪切口——挪的结果是保留的原文可能多于 6 条，绝不会少于 6 条。
 */
export function alignToTurnStart(messages: Message[], cut: number): number {
  let at = cut
  while (at > 0 && messages[at].role === 'tool') at -= 1
  return at
}

/** 摘要节点写回状态的那份增量。messages 是「整份替换」，不是追加。 */
export interface SummaryUpdate {
  kept: Message[]
  summary: string
  /** 压掉了几条原文，打印用 */
  compressed: number
  reason: string
}

/**
 * 把早期消息压成一段摘要，保留最近若干条原文。
 *
 * 这个函数的签名里**没有 attachments**，这不是疏忽，是本章的正题：
 * 附件字段存的是引用（ref）不是内容，摘要一段引用等于把它变成一句「有一张图」——
 * 引用没了，图就再也取不回来了。所以摘要根本不该看见它。
 */
export async function buildSummaryUpdate(
  messages: Message[],
  previousSummary: string | undefined,
  reason: string
): Promise<SummaryUpdate | null> {
  const rawCut = messages.length - KEEP_RECENT
  const cut = alignToTurnStart(messages, rawCut)
  if (cut <= 0) return null

  const head = messages.slice(0, cut)
  const kept = messages.slice(cut)

  // 历史保真的关键在这个 prompt 里：每一行都带着**第几条**和**谁说的**。
  // 多 Agent 场景下 Critic 要靠「这句结论是执行者给的还是用户提的」来判断，
  // 摘要一旦把发言人抹平成一段流水叙述，评审就失去了判据。
  const transcript = head.map((m, i) => `#${i + 1} ${m.role}: ${textOf(m)}`).join('\n')
  const digest = await callModel(
    'summarize',
    `${previousSummary ? `已有摘要（要合并进新摘要，不要丢）：${previousSummary}\n` : ''}早期对话（共 ${head.length} 条）：\n${transcript}`
  )

  return { kept, summary: digest, compressed: head.length, reason }
}

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content
  if (message.role === 'assistant' && message.tool_calls) {
    return `（发起工具调用 ${message.tool_calls.map((c) => c.function.name).join(', ')}）`
  }
  return '（无文本内容）'
}
