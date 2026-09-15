/**
 * 断流续播与去重。
 *
 * 流断在半路是常态：网络抖动、代理超时、用户切后台被系统回收连接。
 * 续播的做法是重新发起请求并告诉服务端「我已经收到哪里了」，
 * 但服务端的重放边界不可能精确到字节，所以**一定会重复发一些已收到的事件**。
 *
 * 于是前端必须自己去重。这一节的核心是：**按标识去重，不要按内容去重**。
 */

import type { BaseEvent } from '../protocol/events'

/** 一个事件的去重键。返回 null 表示这类事件不参与去重（比如纯增量）。 */
export function dedupeKey(event: BaseEvent): string | null {
  switch (event.type) {
    // 这几类事件天然幂等：同一个标识重复到达，覆盖一次就好
    case 'TEXT_MESSAGE_START':
    case 'TEXT_MESSAGE_END':
    case 'REASONING_START':
    case 'REASONING_END':
      return `${event.type}:${(event as unknown as { messageId: string }).messageId}`

    case 'TOOL_CALL_START':
    case 'TOOL_CALL_END':
      return `${event.type}:${(event as unknown as { toolCallId: string }).toolCallId}`

    case 'TOOL_CALL_RESULT':
      return `${event.type}:${(event as unknown as { toolCallId: string }).toolCallId}`

    case 'RUN_STARTED':
    case 'RUN_FINISHED':
      return `${event.type}:${(event as unknown as { runId: string }).runId}`

    // 增量类事件**不能**靠标识去重：同一条消息的多个增量共用一个 messageId，
    // 去重会把正文吃掉。它们靠序号处理，见下面的 ResumeTracker。
    default:
      return null
  }
}

/**
 * 续播追踪器。
 *
 * 设计要点：给每个事件一个**单调递增的序号**，续播时告诉服务端最后收到的序号，
 * 服务端从那之后重放。序号由服务端产生并放在事件的 metadata 里。
 *
 * 为什么不按内容去重：模型完全可能连续吐出两个一模一样的增量
 * （比如两个连续的空格，或者重复的标点）。按内容去重会把合法的重复吃掉，
 * 表现是正文莫名其妙少字，而且极难复现。
 */
export class ResumeTracker {
  private seen = new Set<string>()
  private lastSeq = -1

  /** 服务端把序号放在 metadata.seq 里 */
  private static seqOf(event: BaseEvent): number | null {
    const seq = event.metadata?.seq
    return typeof seq === 'number' ? seq : null
  }

  /**
   * 判断这个事件该不该处理。
   * 返回 false 表示是续播产生的重复，跳过。
   */
  accept(event: BaseEvent): boolean {
    const seq = ResumeTracker.seqOf(event)

    if (seq !== null) {
      // 有序号时以序号为准：小于等于已处理的最大序号，说明是重放。
      if (seq <= this.lastSeq) return false
      this.lastSeq = seq
      return true
    }

    // 没有序号时退回按标识去重（只对幂等类事件有效）
    const key = dedupeKey(event)
    if (key === null) return true
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }

  /** 发起续播请求时带上它，告诉服务端从哪继续。 */
  get resumeFrom(): number {
    return this.lastSeq
  }

  reset() {
    this.seen.clear()
    this.lastSeq = -1
  }
}

/**
 * 打断：中止控制器能停住前端，但停不住服务端。
 *
 * 这是个必须讲清楚的事实——`AbortController.abort()` 关闭的是这一侧的连接，
 * 服务端那边的运行**还在跑，token 还在烧**。真正停下来需要服务端配合：
 * 要么它能感知连接关闭（很多运行时能，但不保证），
 * 要么前端另发一个显式的取消请求。
 *
 * 正确做法是两条都做：abort 让界面立刻响应，取消请求让账单真的停下来。
 */
export type StopResult = {
  aborted: boolean
  cancelRequested: boolean
}

export async function stopRun(
  controller: AbortController,
  runId: string,
  cancelEndpoint = '/api/agent/cancel'
): Promise<StopResult> {
  controller.abort()

  try {
    await fetch(cancelEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
      // 注意这个请求**不能**用同一个已 abort 的 signal，
      // 否则它会在发出前就被取消掉——一个很常见的自相矛盾的 bug。
    })
    return { aborted: true, cancelRequested: true }
  } catch {
    // 取消请求失败不影响界面已经停了，如实返回即可
    return { aborted: true, cancelRequested: false }
  }
}
