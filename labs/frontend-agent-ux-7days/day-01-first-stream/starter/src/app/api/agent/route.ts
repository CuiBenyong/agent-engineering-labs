import { encodeEvent } from '@/protocol/decode'
import { buildScript, parseInject } from '@/server/scenarios'

/** 流式响应不能被静态化，也不能被任何一层缓存住。 */
export const dynamic = 'force-dynamic'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    threadId?: string
    runId?: string
  }

  const threadId = body.threadId ?? `thread-${Date.now()}`
  const runId = body.runId ?? `run-${Date.now()}`
  // 故障注入既可以来自环境变量（跑 lab 时方便），也可以来自查询参数（页面上切换方便）。
  const inject = parseInject(new URL(request.url).searchParams.get('inject') ?? process.env.INJECT)

  const steps = buildScript({ threadId, runId, inject })
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const step of steps) {
          if (step.delayMs > 0) await sleep(step.delayMs)
          controller.enqueue(encoder.encode(encodeEvent(step.event)))
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 挡住 Nginx 一类反向代理的缓冲，否则事件会被攒够一批才发出来，
      // 流式效果在生产环境里会莫名其妙消失。
      'X-Accel-Buffering': 'no',
    },
  })
}
