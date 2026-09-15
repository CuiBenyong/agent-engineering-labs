import type { ServerResponse } from 'node:http'

/** D7 定下的四个 SSE 响应头，原样照抄，本天不改。 */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

/** SSE 心跳间隔：15 秒（D7 已定，本天照抄） */
export const HEARTBEAT_MS = 15_000

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 写一帧 SSE。id 就是 seq——客户端重连时会把它原样放进 Last-Event-ID 带回来。 */
export function sendEvent(res: ServerResponse, event: string, data: unknown, id?: string): void {
  if (res.writableEnded) return
  let frame = ''
  if (id !== undefined) frame += `id: ${id}\n`
  frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  res.write(frame)
}

/** 心跳注释行，客户端忽略，但对链路上的网关来说这就是「还活着」的字节。 */
export function startHeartbeat(res: ServerResponse): () => void {
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, HEARTBEAT_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * 从 Last-Event-ID 算出「该从哪一号继续」。
 * 客户端带回来的是它**最后收到**的那一号，所以要 +1，否则那一号会重复推一次。
 * 没带就从 0 开始——这是首次连接。
 */
export function resumeFrom(lastEventId: string | undefined): number {
  if (!lastEventId) return 0
  const n = Number(lastEventId)
  return Number.isInteger(n) && n >= 0 ? n + 1 : 0
}

/**
 * 保序器：只按 seq 顺序往外交付。
 * 为什么需要它：worker 侧同一条输出流上可能有多个并发写入者（模型片段、工具事件、
 * 状态通知），到达顺序不等于 seq 顺序；而 SSE 是一条只进不退的管子，
 * 推错了顺序没法撤回。所以在推出去之前必须先把号排齐。
 */
export class SeqOrderer {
  private nextSeq: number
  private delivered = 0
  private readonly buffer = new Map<number, string>()

  constructor(
    from: number,
    private readonly emit: (seq: number, text: string) => void
  ) {
    this.nextSeq = from
  }

  get next(): number {
    return this.nextSeq
  }

  get count(): number {
    return this.delivered
  }

  offer(seq: number, text: string): void {
    // 小于当前指针的一律丢弃：重连时「库里回放的片段」和「流上还在飘的片段」
    // 必然重叠，这一行就是幂等回放的全部秘密。
    if (seq < this.nextSeq) return
    this.buffer.set(seq, text)
    // 缺号就先攒着，等它到齐再一起交付——seq 连续不跳号是这个 while 能走通的前提。
    for (let text2 = this.buffer.get(this.nextSeq); text2 !== undefined;) {
      this.buffer.delete(this.nextSeq)
      this.emit(this.nextSeq, text2)
      this.nextSeq += 1
      this.delivered += 1
      text2 = this.buffer.get(this.nextSeq)
    }
  }
}
