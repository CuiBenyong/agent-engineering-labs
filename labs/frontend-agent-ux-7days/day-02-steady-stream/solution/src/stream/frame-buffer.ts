/**
 * 按帧合并：把一批增量攒到一次状态更新里。
 *
 * 问题：模型每秒吐 30–100 个增量，每个增量一次 setState 就是每秒几十上百次完整渲染。
 * 屏幕每秒只刷新 60 次，超出的部分全是白做的功，还会把用户的输入卡住。
 *
 * 解法：收到增量先进缓冲区，用 requestAnimationFrame 约在每一帧末尾统一 flush 一次。
 * 这样渲染次数的上限就被钉在屏幕刷新率上，与模型吐字速度解耦。
 */

export type FrameBufferOptions<T> = {
  /** 一帧攒够之后怎么合并，默认直接把数组交出去 */
  flush: (batch: T[]) => void
  /**
   * 没有 requestAnimationFrame 的环境（Node、测试）用它兜底。
   * 传 0 表示同步 flush，便于断言。
   */
  fallbackDelayMs?: number
}

export type FrameBuffer<T> = {
  push: (item: T) => void
  /** 立刻 flush 掉缓冲区，用于流结束时收尾 */
  flushNow: () => void
  /** 取消挂起的帧，组件卸载时必须调用 */
  dispose: () => void
  /** 统计用：一共 flush 了多少次。lab 里用它量渲染次数 */
  readonly flushCount: number
}

export function createFrameBuffer<T>(options: FrameBufferOptions<T>): FrameBuffer<T> {
  const { flush, fallbackDelayMs = 0 } = options

  let buffer: T[] = []
  let handle: number | null = null
  let count = 0

  const hasRaf = typeof requestAnimationFrame === 'function'

  const schedule = (fn: () => void): number =>
    hasRaf ? requestAnimationFrame(fn) : (setTimeout(fn, fallbackDelayMs) as unknown as number)

  const cancel = (id: number) => {
    if (hasRaf) cancelAnimationFrame(id)
    else clearTimeout(id as unknown as NodeJS.Timeout)
  }

  const doFlush = () => {
    handle = null
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    count += 1
    flush(batch)
  }

  return {
    push(item: T) {
      buffer.push(item)
      // 关键：一帧之内只排一次。后续 push 只是往缓冲区里加，不会再排新的帧。
      if (handle === null) {
        handle = schedule(doFlush)
      }
    },

    flushNow() {
      if (handle !== null) {
        cancel(handle)
        handle = null
      }
      doFlush()
    },

    dispose() {
      if (handle !== null) {
        cancel(handle)
        handle = null
      }
      buffer = []
    },

    get flushCount() {
      return count
    },
  }
}
