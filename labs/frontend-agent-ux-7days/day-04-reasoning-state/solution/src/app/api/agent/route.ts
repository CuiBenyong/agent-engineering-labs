import { encodeEvent } from '@/protocol/decode'
import { buildScript, parseInject, type ScriptStep } from '@/server/scenarios'
import { buildInterruptScript, buildResumeScript, buildToolScript } from '@/server/script-tools'
import { buildBadPatchScript, buildReasoningScript } from '@/server/script-reasoning'

export const dynamic = 'force-dynamic'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 恢复条目：前端把用户对某次中断的决定放在这里带回来。
 * 字段名对齐 AG-UI 的 ResumeEntry。
 */
type ResumeEntry = {
  interruptId: string
  status: 'resolved' | 'cancelled'
  payload?: unknown
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    threadId?: string
    runId?: string
    resume?: ResumeEntry[]
  }

  const threadId = body.threadId ?? `thread-${Date.now()}`
  const runId = body.runId ?? `run-${Date.now()}`
  const inject = parseInject(new URL(request.url).searchParams.get('inject') ?? process.env.INJECT)
  const ctx = { threadId, runId, inject }

  let steps: ScriptStep[]

  // 带着决定回来的请求，走续跑剧本。
  //
  // 注意这里是**服务端**在决定要不要真的执行——前端的审批界面只是采集决定，
  // 它拦不住任何东西。把前端当安全边界是个典型错误：改改请求就绕过去了。
  const decision = body.resume?.[0]
  if (decision) {
    steps = buildResumeScript(ctx, decision)
  } else if (inject === 'interrupt') {
    steps = buildInterruptScript(ctx)
  } else if (inject === 'none') {
    steps = buildReasoningScript(ctx)
  } else if (inject === 'slow') {
    // slow 在 D4 复用为「补丁打不上」的演示，剧本名字比取值更能说明意图
    steps = buildBadPatchScript(ctx)
  } else if (inject === 'burst') {
    steps = buildToolScript(ctx)
  } else {
    steps = buildScript(ctx)
  }

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
      'X-Accel-Buffering': 'no',
    },
  })
}
