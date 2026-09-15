/**
 * 传输层的接口，以及两种传输都要用的**分帧**。本天新增。
 *
 * 2026-07-28 这一版只剩两种传输：stdio 与 Streamable HTTP。它们的差别不在于「谁快」，
 * 而在于**字节从哪儿来**，以及**一条消息的边界由谁划**：
 *
 *   stdio  字节是一条永不结束的流，边界要自己按换行切（这个文件里的 LineFramer）
 *   HTTP   字节属于某一次 POST 的响应体，边界由 HTTP 自己划（或者由 SSE 的空行划）
 *
 * 接口刻意做得很薄——只管「把一条消息送出去」和「收到一条消息时叫我」。
 * 请求与响应怎么配对、超时怎么算、翻页怎么翻，全在上面一层 client.ts 里，
 * 两种传输一行都不重复。**这条分层是今天最值钱的一块：加第三种传输时，
 * 只要再实现这四个方法，客户端与聚合层一个字都不用改。**
 */
import type { JsonRpcMessage } from './protocol.js'

export interface Transport {
  readonly kind: 'stdio' | 'http'
  /** 给人看的一句话，出错时打在日志里 */
  readonly label: string
  start(): Promise<void>
  /** 只负责把字节送出去，不等回复 */
  send(payload: JsonRpcMessage): Promise<void>
  close(): Promise<void>
  /** 收到一条完整消息时回调。响应与通知都走这里，由上层按有没有 id 分开 */
  onMessage(handler: (message: JsonRpcMessage) => void): void
  /** 传输本身死了（子进程退出、连接断开）。上层据此把所有在等的请求一次性失败掉 */
  onFatal(handler: (error: Error) => void): void
}

/**
 * 按换行切帧。看起来一行代码就够（`chunk.split('\n')`），但那样写有一个必错的坑：
 *
 * **一次 data 事件拿到的不是一行，而是「上一次剩下的半行 + 这次的若干行 + 这次剩下的半行」。**
 * 操作系统只保证字节顺序，不保证边界。一个稍大的工具结果（几 KB）一定会被切成多块，
 * 于是直接 split 的客户端会在这里 JSON.parse 失败——而且失败得很不稳定：
 * 小结果一切正常，大结果偶尔报错，本机好好的换台机器就坏。
 *
 * 所以必须留一个缓冲区：**只把带换行的那部分交出去，最后那截没换行的留着等下一块。**
 * 这个类是纯逻辑，自检里直接把一条报文从中间劈开喂进去断言它能拼回来。
 */
export class LineFramer {
  private buffer = ''

  /**
   * TODO(1)：喂一块字节，吐出这一块里所有**完整**的行。
   *
   * 下面这版是直觉写法，它在小报文上一切正常，一遇到大结果就开始 JSON.parse 失败，
   * 而且失败得很不稳定。想清楚一次 data 事件拿到的到底是什么，然后把 buffer 用起来。
   */
  push(chunk: string): string[] {
    return chunk
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  /** 流结束时把剩下的半行交出来。没有换行结尾的最后一条报文靠它才不会丢 */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? [rest] : []
  }
}

/** 一行文本解析成一条消息。解析不了就返回 null，绝不抛——一行坏报文不该杀掉传输 */
export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    const value = JSON.parse(line) as unknown
    if (typeof value !== 'object' || value === null) return null
    return value as JsonRpcMessage
  } catch {
    return null
  }
}
