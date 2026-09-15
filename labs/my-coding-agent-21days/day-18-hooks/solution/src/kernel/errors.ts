/**
 * 错误分类。本天新增，是今天全部代码的判据来源。
 *
 * 六类故障、三种处理，一张表就说完了：
 *
 *   故障            这一层看到的东西            处理     为什么
 *   工具执行失败    ToolResult.ok 为 false      回灌     模型改个参数、换个路径就能自己解决
 *   参数不是 JSON   拼完的 args 解析不了        回灌     它写坏的，把原文给它看，它就重写
 *   模型在打转      同工具同参数连续三次        回灌     它自己看不出在打转，得有人告诉它
 *   命令超时        子进程被杀掉                回灌     结果里带上「把命令拆小」，它才会改策略
 *   网关限流        429 / RateLimitError        重试     跟模型无关，等一会儿就好
 *   流在中途断开    收不到 finish 也没有 [DONE] 看情况   还没吐字就重试，吐过字就抬头
 *
 * 判据只有一条，而且可以背下来：
 *   **这个错误模型自己改得动吗？改得动就回灌，改不动但换个时机能好就重试，两条都不成立才抬头。**
 *
 * 「抬头」是最后一档，意思是打断这一轮、把话说给人听。它很贵——用户的注意力比几次重试贵得多，
 * 所以只留给两种情况：环境坏了（没有 key、网关一直不通），以及硬上限触发（见 limits.ts）。
 */
import type { ToolResult } from './types.js'
import { RateLimitError, StreamTruncatedError } from '../providers/gateway.js'

/** 三种处理路径 */
export type Handling = 'feedback' | 'retry' | 'surface'

export interface Diagnosis {
  handling: Handling
  /** 给人看的一句话。回灌路径下它同时也是给模型看的 */
  message: string
  /** 重试路径下的建议等待毫秒数（还没加抖动） */
  retryAfterMs?: number
}

/**
 * 网关层错误的分类。
 *
 * `emitted` 是「这一次尝试已经对外吐出过多少个分片」，它是本文件最重要的一个参数：
 * **重试的前提是这次尝试没有留下任何用户已经看见的痕迹。**
 * 限流是在第一个字节之前失败的，所以可以悄悄重试；断流是吐了一半才断的，
 * 重试会让用户看到同一段话说两遍——那不是恢复，那是错乱。
 */
export function diagnoseStreamError(error: unknown, emitted: number): Diagnosis {
  if (error instanceof RateLimitError) {
    return {
      handling: 'retry',
      message: `网关限流（${error.retryAfterMs}ms 后可重试）`,
      retryAfterMs: error.retryAfterMs,
    }
  }

  if (error instanceof StreamTruncatedError) {
    // 一个字都还没吐出来：这一轮等于没开始，重试是安全的
    if (emitted === 0) {
      return { handling: 'retry', message: '流在开头就断了，还没有输出任何内容', retryAfterMs: 500 }
    }
    // 已经吐过字：不许重试。保留收到的部分，把选择权交回用户
    return {
      handling: 'surface',
      message: `${error.message}。重试会让同一段话说两遍，所以这一轮不重试`,
      retryAfterMs: undefined,
    }
  }

  // 网络层的抖动（DNS、连接被重置）也归重试，判据同样是「还没吐字」
  if (emitted === 0 && looksTransient(error)) {
    return { handling: 'retry', message: `网络抖动：${describeError(error)}`, retryAfterMs: 500 }
  }

  return { handling: 'surface', message: describeError(error) }
}

/**
 * 工具层失败一律回灌，一条都不抬头。
 *
 * 这里返回的文本就是模型下一步的行为规范，所以它必须**具体到可操作**：
 * 「失败了」什么都不会发生，「那段 old_string 在文件里出现了 3 次，请把上下文写长一点」
 * 会让它下一轮就改对。工具自己已经按这个要求写了结果文本，所以这里只加一层兜底。
 */
export function diagnoseToolResult(result: ToolResult): Diagnosis {
  if (result.ok) return { handling: 'feedback', message: result.content }
  const vague = result.content.trim().length < 12
  return {
    handling: 'feedback',
    message: vague ? `${result.content}（没有更多信息，请换一种做法再试一次）` : result.content,
  }
}

/** 只按错误名与文案判断，不去猜 errno 的具体取值——各运行时不一样 */
function looksTransient(error: unknown): boolean {
  const text = describeError(error)
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(text)
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
