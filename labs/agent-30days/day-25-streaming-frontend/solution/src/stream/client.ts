/**
 * 取消协议的客户端 + 幂等键 + 节流批量 flush。
 * 三样都与 React 无关，所以能在 Node 里直接自测。
 */
import { createSseParser, type SseFrame } from './parse'

/** 节流窗口：30ms 一批。60Hz 屏幕一帧 16.7ms，30ms 肉眼看不出差别。 */
export const FLUSH_INTERVAL_MS = 30

/**
 * 一次发送尝试。重试时必须复用**同一个** idempotencyKey，
 * 所以键生成在 newAttempt 里、只生成一次，retryAttempt 原样带走。
 */
export interface Attempt {
  clientMessageId: string
  text: string
  idempotencyKey: string
}

export function newAttempt(text: string): Attempt {
  // Web Crypto 在浏览器和 Node 18+ 里是同一个 API，同一份代码两边都能跑
  const id = globalThis.crypto.randomUUID()
  return { clientMessageId: id, text, idempotencyKey: `msg:${id}` }
}

/**
 * 重试：只是把同一次尝试再发一遍，幂等键一个字都不能变。
 * 换了键，后端就认不出这是同一句话，会真的再跑一个 run——重复扣费、重复副作用。
 */
export function retryAttempt(prev: Attempt): Attempt {
  return { ...prev }
}

/** 批量 flush 调度器：token 先攒着，到点一次性交出去。 */
export interface FlushScheduler {
  push(text: string): void
  /** 收尾时把残留的一批立刻交出去，别让最后几个字停在缓冲里。 */
  flushNow(): void
  stop(): void
}

export function createFlushScheduler(
  onFlush: (batch: string) => void,
  intervalMs: number = FLUSH_INTERVAL_MS
): FlushScheduler {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const fire = (): void => {
    timer = null
    if (pending === '') return
    const batch = pending
    pending = ''
    onFlush(batch)
  }

  return {
    push(text: string): void {
      pending += text
      // 已经有定时器就不再排一个：这才叫节流，否则每个 token 都排一次等于没节流
      if (timer === null) timer = setTimeout(fire, intervalMs)
    },
    flushNow(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      fire()
    },
    stop(): void {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = ''
    },
  }
}

export interface StartedRun {
  runId: string
  /** true 表示后端认出了幂等键，把已有的 run 接回来了，没有重跑 */
  resumed: boolean
}

export async function startRun(
  baseUrl: string,
  sessionId: string,
  attempt: Attempt
): Promise<StartedRun> {
  const res = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: attempt.text,
      clientMessageId: attempt.clientMessageId,
      idempotencyKey: attempt.idempotencyKey,
    }),
  })
  if (!res.ok) throw new Error(`创建 run 失败：HTTP ${res.status}`)
  return (await res.json()) as StartedRun
}

/** 只做「告诉后端别跑了」这一步。单独暴露，是为了让下面那个两步走的函数读起来更清楚。 */
export async function cancelRun(baseUrl: string, runId: string): Promise<void> {
  await fetch(`${baseUrl}/runs/${runId}/cancel`, { method: 'POST' })
}

/**
 * 打断 = 两步，缺一不可：
 *   1. controller.abort()  —— 我不听了（只做这一步，后端还在跑、还在烧钱、还在写库）
 *   2. POST /runs/:id/cancel —— 让它也别说了
 * 这是本章最常见的错，也是面试高频追问。
 */
export async function stopRun(
  controller: AbortController,
  baseUrl: string,
  runId: string
): Promise<void> {
  controller.abort()
  await cancelRun(baseUrl, runId)
}

/** 逐帧消费一个 run 的 SSE。fromSeq 是「我最后收到的那一号」，续传时加一由服务端处理。 */
export async function consumeRun(options: {
  baseUrl: string
  runId: string
  signal: AbortSignal
  lastEventId?: number
  onFrame: (frame: SseFrame) => void
}): Promise<void> {
  const headers: Record<string, string> = {}
  if (options.lastEventId !== undefined) headers['Last-Event-ID'] = String(options.lastEventId)

  const res = await fetch(`${options.baseUrl}/runs/${options.runId}/stream`, {
    headers,
    signal: options.signal,
  })
  if (!res.ok || !res.body) throw new Error(`订阅流失败：HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parse = createSseParser()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // stream: true 让跨块的多字节汉字不会被切成两半（D1 讲过）
      for (const frame of parse(decoder.decode(value, { stream: true }))) options.onFrame(frame)
    }
  } finally {
    reader.releaseLock()
  }
}
