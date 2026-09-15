/**
 * 打转检测。本天新增。
 *
 * 现象长这样：模型调 read_file 读同一个文件、拿到同一段内容、再调 read_file 读同一个文件。
 * 它不是坏了，是**它看不见自己在重复**——每一轮它拿到的上下文里，那两次调用和结果都在，
 * 但「我已经做过一样的事了」这个判断需要跨轮比较，而它只会顺着上下文往下续写。
 *
 * 所以这件事必须由循环来做，而且做法很朴素：把「工具名 + 参数原文」当成一个键，
 * 连续命中同一个键达到阈值就打断。三条口径：
 *
 *   1. **比参数原文，不比语义。** 参数只差一个空格就算不同的调用——这不是漏检，
 *      而是它至少在尝试新东西。真正的打转是一字不差的重复。
 *   2. **只看连续。** 中间插进过别的调用就重新计数：先读文件、再跑测试、再读同一个文件，
 *      这是正常的验证节奏，不是打转。
 *   3. **打断的方式是回灌，不是抬头。** 告诉它「你已经用同样的参数调过三次了，结果都在上面，
 *      换个做法或者直接给结论」，它通常这一轮就换路了。抬头是最后一步，先给它一次机会。
 */
import type { ToolCall } from './types.js'

/** 连续几次一模一样就算在打转。三次是本课的取值：两次很常见（读了改了再读一次确认） */
export const REPEAT_THRESHOLD = 3

export class RepeatDetector {
  private lastKey = ''
  private streak = 0

  /** 喂一次调用，返回它连续出现的次数（含这一次） */
  push(call: ToolCall): number {
    const key = `${call.name}(${call.args.trim()})`
    if (key === this.lastKey) {
      this.streak += 1
    } else {
      this.lastKey = key
      this.streak = 1
    }
    return this.streak
  }

  /** 这次调用是否已经越过阈值 */
  tripped(call: ToolCall): boolean {
    return this.push(call) >= REPEAT_THRESHOLD
  }

  /** 打断时回灌给模型的话。要具体到它能据此改行为 */
  note(call: ToolCall): string {
    return (
      `你已经用完全相同的参数调用 ${call.name} ${this.streak} 次了，这次没有执行。` +
      '前几次的结果都在上面的对话里，不会有新信息。' +
      '请换一个做法：换参数、换工具，或者直接根据已有信息给出结论。'
    )
  }

  reset(): void {
    this.lastKey = ''
    this.streak = 0
  }
}
