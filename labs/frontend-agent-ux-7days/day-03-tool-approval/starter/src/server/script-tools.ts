/**
 * D3 新增剧本：工具调用与中断审批。
 *
 * 注意这是一个**独立文件**，不是往冻结的 scenarios.ts 里加东西——
 * 往那里加会让 D1/D2 的副本立刻过期，一致性校验就废了。
 * 各天的新剧本都按这个方式单独放。
 */

import type { AgentEvent } from '../protocol/events'
import type { ScenarioContext, ScriptStep } from './scenarios'

/** 工具参数是流式拼出来的 JSON 字符串，这里按字符切片模拟。 */
function argDeltas(args: object, size = 8): string[] {
  const json = JSON.stringify(args)
  const out: string[] = []
  for (let i = 0; i < json.length; i += size) out.push(json.slice(i, i + size))
  return out
}

function text(messageId: string, body: string, step = 6): ScriptStep[] {
  const steps: ScriptStep[] = [
    { delayMs: 60, event: { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' } },
  ]
  for (let i = 0; i < body.length; i += step) {
    steps.push({
      delayMs: 20,
      event: { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: body.slice(i, i + step) },
    })
  }
  steps.push({ delayMs: 30, event: { type: 'TEXT_MESSAGE_END', messageId } })
  return steps
}

const SEARCH_ARGS = { query: '同声传译 设备租赁', limit: 5 }
const DELETE_ARGS = { path: 'reports/2026-Q3/', recursive: true }

/**
 * 剧本一（inject 为 none）：一次只读工具调用，不需要审批。
 *
 * 顺序是真实的：模型先说一句「我查一下」，再发起工具调用，
 * 拿到结果后继续说。界面要能把这三段连起来显示。
 */
export function buildToolScript(ctx: ScenarioContext): ScriptStep[] {
  const { threadId, runId } = ctx
  const toolCallId = `call-${runId}-1`
  const steps: ScriptStep[] = [
    { delayMs: 0, event: { type: 'RUN_STARTED', threadId, runId } },
    ...text(`msg-${runId}-a`, '好的，我先查一下相关资料。'),
    {
      delayMs: 80,
      event: {
        type: 'TOOL_CALL_START',
        toolCallId,
        toolCallName: 'search_documents',
        parentMessageId: `msg-${runId}-a`,
      },
    },
  ]

  // 参数逐片到达：界面在这段时间里只能显示「正在准备参数」，
  // 因为半截 JSON 是 parse 不出来的。
  for (const delta of argDeltas(SEARCH_ARGS)) {
    steps.push({ delayMs: 40, event: { type: 'TOOL_CALL_ARGS', toolCallId, delta } })
  }

  steps.push({ delayMs: 30, event: { type: 'TOOL_CALL_END', toolCallId } })

  // 工具执行需要时间，这段空窗期正是卡片显示「执行中」的时候。
  steps.push({
    delayMs: 600,
    event: {
      type: 'TOOL_CALL_RESULT',
      messageId: `msg-${runId}-t`,
      toolCallId,
      content: JSON.stringify({ hits: 3, top: '会议同传设备租赁报价单.pdf' }),
      role: 'tool',
    },
  })

  steps.push(...text(`msg-${runId}-b`, '查到 3 条结果，最相关的是那份报价单。'))
  steps.push({
    delayMs: 40,
    event: { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } },
  })

  return steps
}

/**
 * 剧本二（inject 为 interrupt）：危险工具，运行中断等审批。
 *
 * 这是本课 D3 的核心。关键在于**运行在这里真的结束了**——
 * RUN_FINISHED 带 interrupt outcome，而不是流挂在那里等前端。
 * 前端把用户的决定放进下一次请求的 resume 数组，服务端据此继续。
 */
export function buildInterruptScript(ctx: ScenarioContext): ScriptStep[] {
  const { threadId, runId } = ctx
  const toolCallId = `call-${runId}-del`
  const interruptId = `int-${runId}`

  const steps: ScriptStep[] = [
    { delayMs: 0, event: { type: 'RUN_STARTED', threadId, runId } },
    ...text(`msg-${runId}-a`, '我需要删除那批过期报告，请确认。'),
    {
      delayMs: 80,
      event: {
        type: 'TOOL_CALL_START',
        toolCallId,
        toolCallName: 'delete_files',
        parentMessageId: `msg-${runId}-a`,
      },
    },
  ]

  for (const delta of argDeltas(DELETE_ARGS)) {
    steps.push({ delayMs: 40, event: { type: 'TOOL_CALL_ARGS', toolCallId, delta } })
  }

  steps.push({ delayMs: 30, event: { type: 'TOOL_CALL_END', toolCallId } })

  // 运行到此为止。注意不是「流卡住等前端」，而是这一次运行正常结束了，
  // 只不过结束的方式是 interrupt。
  steps.push({
    delayMs: 60,
    event: {
      type: 'RUN_FINISHED',
      threadId,
      runId,
      outcome: {
        type: 'interrupt',
        interruptId,
        reason: '该工具会不可逆地删除文件，需要你确认',
        payload: { toolCallId, toolCallName: 'delete_files', args: DELETE_ARGS },
      },
    },
  })

  return steps
}

/**
 * 剧本三：用户做完决定之后的续跑。
 *
 * 同意就真的执行并回结果；拒绝则把理由回给模型，让它换个说法继续——
 * 而不是让整个运行失败。「拒绝 = 报错」是个很常见的设计错误：
 * 用户只是不想删文件，不是想让对话崩掉。
 */
export function buildResumeScript(
  ctx: ScenarioContext,
  decision: { interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown }
): ScriptStep[] {
  const { threadId, runId } = ctx
  const approved = decision.status === 'resolved'
  const toolCallId =
    (decision.payload as { toolCallId?: string } | undefined)?.toolCallId ?? `call-${runId}-del`

  const steps: ScriptStep[] = [{ delayMs: 0, event: { type: 'RUN_STARTED', threadId, runId } }]

  if (approved) {
    steps.push({
      delayMs: 400,
      event: {
        type: 'TOOL_CALL_RESULT',
        messageId: `msg-${runId}-t`,
        toolCallId,
        content: JSON.stringify({ deleted: 12, bytes: 48213 }),
        role: 'tool',
      },
    })
    steps.push(...text(`msg-${runId}-b`, '已删除 12 个文件，共约 47 KB。'))
  } else {
    // 拒绝也要有结果回给模型，内容是「被用户拒绝」以及原因。
    steps.push({
      delayMs: 120,
      event: {
        type: 'TOOL_CALL_RESULT',
        messageId: `msg-${runId}-t`,
        toolCallId,
        content: JSON.stringify({ error: 'rejected_by_user', reason: '用户拒绝了删除操作' }),
        role: 'tool',
      },
    })
    steps.push(...text(`msg-${runId}-b`, '好的，不删了。需要我改成先归档这批报告吗？'))
  }

  steps.push({
    delayMs: 40,
    event: { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } },
  })

  return steps
}

/** 判断一个事件是不是带中断的运行结束，方便前端收窄类型。 */
export function readInterrupt(
  event: AgentEvent
): { interruptId: string; reason?: string; payload?: unknown } | null {
  if (event.type !== 'RUN_FINISHED') return null
  const outcome = event.outcome
  if (!outcome || outcome.type !== 'interrupt') return null
  return { interruptId: outcome.interruptId, reason: outcome.reason, payload: outcome.payload }
}
