import { encodeEvent } from '@/protocol/decode'
import { buildScript, parseInject, type InjectMode, type ScriptStep } from '@/server/scenarios'
import { buildInterruptScript, buildResumeScript } from '@/server/script-tools'
import { buildBadPatchScript, buildReasoningScript } from '@/server/script-reasoning'
import { buildGenerativeScript, buildUnknownComponentScript } from '@/server/script-generative'
import {
  buildResumeScript as buildReplayScript,
  buildWorkbenchScript,
} from '@/server/script-workbench'

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
    /** 续播：告诉服务端我已经收到到第几号事件了 */
    resumeFrom?: number
  }

  const threadId = body.threadId ?? `thread-${Date.now()}`
  const runId = body.runId ?? `run-${Date.now()}`
  const inject = parseInject(new URL(request.url).searchParams.get('inject') ?? process.env.INJECT)
  const ctx = { threadId, runId, inject }

  // 剧本表：inject 取值 → 剧本函数。
  //
  // 这里原本是一条逐天追加的 if 链，到 D6 已经出现同一个取值被赋两次含义的 bug
  // （burst 既指向工具剧本又指向生成式剧本，后一个分支永远不可达，
  // 而 TypeScript 只是在类型收窄时才把它报出来）。
  // 改成一张表之后，重复的键在语法层面就不可能存在了。
  const SCRIPTS: Partial<Record<InjectMode, (c: typeof ctx) => ScriptStep[]>> = {
    none: buildWorkbenchScript,
    burst: buildGenerativeScript,
    'unknown-component': buildUnknownComponentScript,
    cut: buildReasoningScript,
    slow: buildBadPatchScript,
    interrupt: buildInterruptScript,
  }

  let steps: ScriptStep[]

  const decision = body.resume?.[0]
  if (decision) {
    // 带着用户决定回来的请求，走续跑剧本。
    //
    // 注意这里是**服务端**在决定要不要真的执行——前端的审批界面只是采集决定，
    // 它拦不住任何东西。把前端当安全边界是个典型错误：改改请求就绕过去了。
    steps = buildResumeScript(ctx, decision)
  } else if (typeof body.resumeFrom === 'number') {
    // 续播请求：从断点附近重放。注意会重复发几条，去重是前端的责任。
    steps = buildReplayScript(ctx, body.resumeFrom)
  } else {
    steps = (SCRIPTS[inject] ?? buildScript)(ctx)
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
