// 失败分类表：把「出错了」变成「该怎么办」。
// 判据不是状态码的首位数字，是这三个问题：
//   换个时间再来会不会好？（限流、服务端故障 → 会）
//   换个参数会不会好？（参数无效、内容被拦 → 会，但要改的是你自己的输入）
//   得叫人来才行？（鉴权失败、余额不足 → 是，程序自己重试一万次也没用）

import { MiniMaxError } from './providers/index.js'
import { TaskFailedError, TaskTimeoutError } from './video-task.js'

/** 六类厂商错误，取自 providers/minimax.ts 里那张 status_code 映射表。 */
type MiniMaxFailureKind = MiniMaxError['kind']

/** 三种处置，全课只有这三种，不要再发明第四种。 */
export type Disposition = 'retry' | 'fix-input' | 'alert'

export type Verdict = {
  kind: MiniMaxFailureKind | 'timeout' | 'task-failed' | 'unknown'
  disposition: Disposition
  /** 说给人看的一句话，直接进日志与告警 */
  reason: string
  /** 这一类要不要走退避重试 */
  retryable: boolean
}

// 练习 3：把这张表填对。判据是本文件开头那三个问题，不是状态码的首位数字。
// 提示：默认实现把六类错误全判成 retry，于是第 4 步的分类表会整列都是 retry——
//       鉴权失败和敏感内容也在重试，这正是「一刀切重试」最典型的样子：
//       白烧钱、把限流拖得更久，而且真正需要人介入的两类被无限期地拖住了。
const DISPOSITIONS: Record<MiniMaxFailureKind, { disposition: Disposition; reason: string }> = {
  'rate-limited': { disposition: 'retry', reason: '触发限流，退避之后重试通常能成' },
  server: { disposition: 'retry', reason: '服务端故障，退避之后重试通常能成' },
  'bad-request': { disposition: 'retry', reason: '（练习 3）' },
  'content-blocked': { disposition: 'retry', reason: '（练习 3）' },
  auth: { disposition: 'retry', reason: '（练习 3）' },
  'insufficient-balance': { disposition: 'retry', reason: '（练习 3）' },
}

export function classify(err: unknown): Verdict {
  if (err instanceof MiniMaxError) {
    const { disposition, reason } = DISPOSITIONS[err.kind]
    return { kind: err.kind, disposition, reason, retryable: disposition === 'retry' }
  }
  if (err instanceof TaskTimeoutError) {
    // 超时是「不知道成没成」，不是「失败了」：任务可能还在对方队列里跑。
    // 所以重试之前要先想清楚幂等，否则你会为同一个镜头付两次钱。D8 会把这件事做成引擎的一部分。
    return {
      kind: 'timeout',
      disposition: 'retry',
      reason: '排队超过预算，先放弃这次等待；重试前必须先按幂等键查一次有没有已完成的产物',
      retryable: true,
    }
  }
  if (err instanceof TaskFailedError) {
    return {
      kind: 'task-failed',
      disposition: 'fix-input',
      reason: '任务本身跑失败了，先看提示词与首帧，盲目重试大概率还是失败',
      retryable: false,
    }
  }
  return {
    kind: 'unknown',
    disposition: 'alert',
    reason: '没见过的错误，先报警别静默吞掉',
    retryable: false,
  }
}

export type RetryOptions = {
  attempts: number
  initialWaitMs: number
  maxWaitMs: number
  onAttempt?: (info: { attempt: number; verdict: Verdict; waitMs: number }) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 只对分类为 retry 的错误退避重试；其余立刻抛出，不浪费预算。 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let waitMs = opts.initialWaitMs
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      const verdict = classify(err)
      if (!verdict.retryable || attempt >= opts.attempts) throw err
      opts.onAttempt?.({ attempt, verdict, waitMs })
      await sleep(waitMs)
      waitMs = Math.min(waitMs * 2, opts.maxWaitMs)
    }
  }
}

/** 演示用：把整张分类表打印出来，读者一眼看到「哪些重试、哪些别重试」。 */
export const SAMPLE_CODES: { code: number; note: string }[] = [
  { code: 1002, note: '限流' },
  { code: 1004, note: '鉴权失败' },
  { code: 1008, note: '余额不足' },
  { code: 1026, note: '敏感内容' },
  { code: 1027, note: '敏感内容' },
  { code: 2013, note: '参数无效' },
]
