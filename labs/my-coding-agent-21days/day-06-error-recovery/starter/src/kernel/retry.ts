/**
 * 带抖动的退避重试。本天新增，包在 provider.stream 外面。
 *
 * 位置很关键：**重试只包网关这一层，不包整轮。**
 * 工具失败重试整轮，会把「已经改了一半的文件」再改一遍——重试的前提是这一步幂等，
 * 而写工具天生不幂等。所以工具失败走回灌（见 errors.ts），只有网关错误走这里。
 *
 * 为什么要抖动（jitter）：假设你的 Agent 被限流了，同时被限流的还有另外五十个进程。
 * 如果大家都是「等 1 秒再试」，一秒之后五十个请求会一起撞上去，再一起被拒，
 * 再一起等一秒——限流被你们自己拖成了一场雪崩，而且是周期性的。
 * 加一段随机等待，就是把这五十个请求摊到一个时间窗里。
 */
import type { ChatProvider, ChatRequest, StreamDelta } from '../providers/types.js'
import { diagnoseStreamError } from './errors.js'

export interface RetryOptions {
  /** 一共尝试几次（含第一次）。默认 3 */
  maxAttempts?: number
  /** 退避窗口的起点毫秒数。默认 400 */
  baseMs?: number
  /** 退避窗口的上限。默认 8000——再长用户就该自己决定了 */
  capMs?: number
  /** 注入随机源，方便自检里把抖动固定住 */
  random?: () => number
  /** 每次决定重试时回调一次，用来在终端上说明「为什么等」 */
  onRetry?: (info: { attempt: number; waitMs: number; message: string }) => void
}

const DEFAULTS = { maxAttempts: 3, baseMs: 400, capMs: 8000 }

/**
 * 第 attempt 次失败之后该等多久（attempt 从 1 起）。
 *
 * 用的是「等量抖动」：窗口按 2 的幂增长到上限，实际等待取窗口的后半段随机一点。
 * 不用「全抖动」（0 到窗口之间随机）是因为它有可能抽到几毫秒，等于没退避；
 * 也不用固定间隔，理由见文件头。
 */
export function backoffDelay(
  attempt: number,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {}
): number {
  const baseMs = options.baseMs ?? DEFAULTS.baseMs
  const capMs = options.capMs ?? DEFAULTS.capMs
  const random = options.random ?? Math.random
  // TODO(2)：把这个固定间隔改成「窗口按 2 的幂增长 + 等量抖动」。
  //   窗口 = min(capMs, baseMs * 2 的 (attempt-1) 次幂)
  //   实际等待 = 窗口的一半 + random() 抽到的窗口后半段里的一点
  // 提示：不要写成「0 到窗口之间随机」——那有可能抽到几毫秒，等于没退避。
  // 现在这个写法的问题不会在你一个人跑的时候暴露：它只在很多进程同时被限流时才会
  // 把限流拖成周期性雪崩。自检第 2 项用固定随机源把它验出来。
  void capMs
  void random
  return baseMs
}

/**
 * 包一层重试的流。
 *
 * 只有一种情况会重试：**这次尝试一个分片都还没吐出去**，而且诊断结果是 retry。
 * 一旦吐过字，重试就会让用户看到同一段话说两遍，所以宁可把错误抬头。
 * 这个「已经吐过字就不重试」的判据由 emitted 计数守着，是本文件唯一的状态。
 */
export async function* streamWithRetry(
  provider: ChatProvider,
  req: ChatRequest,
  options: RetryOptions = {}
): AsyncIterable<StreamDelta> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts

  for (let attempt = 1; ; attempt += 1) {
    let emitted = 0
    try {
      for await (const delta of provider.stream(req)) {
        emitted += 1
        yield delta
      }
      return
    } catch (error) {
      // 用户按了取消：这不是故障，别重试，原样抛出去让循环收尾
      if (req.signal?.aborted) throw error

      const diagnosis = diagnoseStreamError(error, emitted)
      if (diagnosis.handling !== 'retry' || attempt >= maxAttempts) throw error

      // 网关给了 retry-after 就把它当下限：它比我们的猜测准
      const waitMs = Math.max(backoffDelay(attempt, options), diagnosis.retryAfterMs ?? 0)
      options.onRetry?.({ attempt, waitMs, message: diagnosis.message })
      await sleep(waitMs, req.signal)
    }
  }
}

/** 等待期间也要能被取消，否则按下取消还要干等一次退避 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}
