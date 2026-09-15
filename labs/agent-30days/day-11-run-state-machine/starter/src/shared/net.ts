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
  // 练习 3：把 Last-Event-ID 换算成「该从哪一号继续」。
  // 现在一律从 0 开始，等于每次重连都把整段回复重放一遍——
  // 自检第 4 项会看到重连后的第一号还是 0、合起来有重复片段。
  // 注意客户端带回来的是它**最后收到**的那一号，不是它想要的下一号。
  void lastEventId
  return 0
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
    // 练习 2：现在是「到了就推」，SSE 上的顺序等于到达顺序。
    // 但 worker 侧同一条输出流上有多个并发写入者，到达顺序不等于 seq 顺序，
    // 自检第 2 项会看到 seq 变成 0,1,2,3,5,4,… ——而 SSE 是只进不退的管子，推错了收不回来。
    // 要做的三件事：seq 小于 this.nextSeq 的直接丢弃（重连回放与流上的片段必然重叠）；
    // 其余先放进 this.buffer；再从 this.nextSeq 开始，把连号的一次性交付出去。
    this.nextSeq = Math.max(this.nextSeq, seq + 1)
    this.delivered += 1
    this.emit(seq, text)
  }
}
