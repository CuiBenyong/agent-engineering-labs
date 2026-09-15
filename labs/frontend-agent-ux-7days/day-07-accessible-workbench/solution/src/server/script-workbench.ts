/**
 * D6 新增剧本：长任务、子 Agent、断流续播。
 * 独立文件，不动冻结的 scenarios.ts。
 */

import type { ScenarioContext, ScriptStep } from './scenarios'

function text(messageId: string, body: string, sub?: string): ScriptStep[] {
  const steps: ScriptStep[] = [
    {
      delayMs: 50,
      event: { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant', subagentRunId: sub },
    },
  ]
  for (let i = 0; i < body.length; i += 8) {
    steps.push({
      delayMs: 22,
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId,
        delta: body.slice(i, i + 8),
        subagentRunId: sub,
      },
    })
  }
  steps.push({ delayMs: 30, event: { type: 'TEXT_MESSAGE_END', messageId, subagentRunId: sub } })
  return steps
}

/**
 * 长任务剧本：用运行阶段事件把进度拆成看得见的步骤，
 * 并派两个子 Agent 并行干活。
 *
 * 子 Agent 的事件靠 subagentRunId 归组——和消息靠 messageId、
 * 工具靠 toolCallId 是同一个套路：流式协议里的归并一律靠标识不靠顺序。
 */
export function buildWorkbenchScript(ctx: ScenarioContext): ScriptStep[] {
  const { threadId, runId } = ctx
  const steps: ScriptStep[] = [
    { delayMs: 0, event: { type: 'RUN_STARTED', threadId, runId } },
    { delayMs: 60, event: { type: 'STEP_STARTED', stepName: '拆解任务' } },
    ...text(`msg-${runId}-a`, '这个任务我拆成两块并行处理。'),
    { delayMs: 40, event: { type: 'STEP_FINISHED', stepName: '拆解任务' } },

    { delayMs: 60, event: { type: 'STEP_STARTED', stepName: '并行收集' } },
    {
      delayMs: 80,
      event: {
        type: 'SUBAGENT_STARTED',
        subagentRunId: 'sub-a',
        name: '财务数据',
        description: '从财务系统拉取本季数据',
      },
    },
    {
      delayMs: 60,
      event: {
        type: 'SUBAGENT_STARTED',
        subagentRunId: 'sub-b',
        name: '市场数据',
        description: '汇总同期市场基准',
      },
    },
  ]

  // 两个子 Agent 的事件交错到达，前端必须按 subagentRunId 归位
  const a = text(`msg-${runId}-sa`, '营收与成本已取到。', 'sub-a')
  const b = text(`msg-${runId}-sb`, '同行业均值已汇总。', 'sub-b')
  const maxLen = Math.max(a.length, b.length)
  for (let i = 0; i < maxLen; i += 1) {
    if (a[i]) steps.push(a[i])
    if (b[i]) steps.push(b[i])
  }

  steps.push({
    delayMs: 80,
    event: { type: 'SUBAGENT_FINISHED', subagentRunId: 'sub-a', result: { ok: true } },
  })
  steps.push({
    delayMs: 60,
    event: { type: 'SUBAGENT_FINISHED', subagentRunId: 'sub-b', result: { ok: true } },
  })
  steps.push({ delayMs: 40, event: { type: 'STEP_FINISHED', stepName: '并行收集' } })

  steps.push({ delayMs: 60, event: { type: 'STEP_STARTED', stepName: '汇总成文' } })
  steps.push(...text(`msg-${runId}-c`, '两边数据对齐后，结论是营收增速高于行业均值。'))
  steps.push({ delayMs: 40, event: { type: 'STEP_FINISHED', stepName: '汇总成文' } })

  steps.push({
    delayMs: 40,
    event: { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } },
  })

  // 给每个事件编号：续播时前端拿最后收到的序号告诉服务端从哪继续。
  return steps.map((step, i) => ({
    ...step,
    event: { ...step.event, metadata: { ...(step.event.metadata ?? {}), seq: i } },
  }))
}

/**
 * 续播剧本：模拟「断流之后重连」的第二段。
 *
 * 关键是它**从头重放**了几条已经发过的事件——服务端的重放边界不可能精确，
 * 所以重复是必然的，去重是前端的责任。
 */
export function buildResumeScript(ctx: ScenarioContext, resumeFrom: number): ScriptStep[] {
  const full = buildWorkbenchScript(ctx)
  // 故意往前多回放 3 条，制造重复
  const start = Math.max(0, resumeFrom - 3)
  return full.slice(start)
}
