/**
 * 工具结果的截断策略。本天新增，之后每天的工具都走这一处。
 *
 * 为什么必须截：工具结果是要回灌进消息数组的，而消息数组每一轮都整体重发一次。
 * 一个 grep 命中两千行，你就在接下来每一轮都为这两千行付一次输入 token，
 * 而且很快会把上下文窗口顶满。
 *
 * 三条口径，全课统一：
 *   1. 上限 8000 字符（约等于两三千 token，一次工具结果占的份额不该超过这个量级）
 *   2. 从中间截，保留首尾——头部通常是最相关的命中或文件开头，
 *      尾部往往有结论性的信息（报错的最后一行、测试的汇总行）。只留头会丢掉结论。
 *   3. 必须告诉模型截掉了多少，并给出下一步动作。模型看不到「省略号」的含义，
 *      但看得懂「还有 12000 字符，请用 offset 继续读」。
 */
import type { ToolResult } from './types.js'

export const MAX_RESULT_CHARS = 8000
/** 头尾各留多少：头多一点，因为最相关的内容通常在前面 */
const HEAD_RATIO = 0.6

export function truncateResult(result: ToolResult): ToolResult {
  const text = result.content
  if (text.length <= MAX_RESULT_CHARS) return result

  const headLength = Math.floor(MAX_RESULT_CHARS * HEAD_RATIO)
  const tailLength = MAX_RESULT_CHARS - headLength
  const removed = text.length - MAX_RESULT_CHARS
  const note = `\n…（中间已截断 ${removed} 字符，全文共 ${text.length} 字符；需要中间部分请带 offset 再读一次）…\n`

  return {
    ...result,
    content: text.slice(0, headLength) + note + text.slice(text.length - tailLength),
    // 截断这件事只给人看，不必再占模型的 token：meta 不回灌
    meta: { ...result.meta, truncated: true, originalChars: text.length, removedChars: removed },
  }
}
