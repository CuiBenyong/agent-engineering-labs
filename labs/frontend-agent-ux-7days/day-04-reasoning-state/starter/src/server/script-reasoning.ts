/**
 * D4 新增剧本：推理过程与共享状态。
 * 独立文件，不动冻结的 scenarios.ts（理由见 D3 的 script-tools.ts）。
 */

import type { ScenarioContext, ScriptStep } from './scenarios'

const REASONING =
  '用户问的是季度报告，先确认口径：是自然季度还是财年季度。' +
  '从上下文看提到了 Q3 和 2026，财年信息没给，按自然季度处理更稳妥。' +
  '接下来需要三样数据：营收、成本、环比。先查营收。'

const ANSWER = '按自然季度口径整理好了，2026 年 Q3 营收环比增长 12%。'

function streamText(messageId: string, body: string, step = 8): ScriptStep[] {
  const steps: ScriptStep[] = [
    { delayMs: 50, event: { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' } },
  ]
  for (let i = 0; i < body.length; i += step) {
    steps.push({
      delayMs: 22,
      event: { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: body.slice(i, i + step) },
    })
  }
  steps.push({ delayMs: 30, event: { type: 'TEXT_MESSAGE_END', messageId } })
  return steps
}

/**
 * 推理 + 共享状态剧本。
 *
 * 时序刻意做成真实的样子：先推理（用户看到「思考中」），
 * 推理结束后状态快照打底，然后随着工作推进发增量补丁，最后才是正式回答。
 */
export function buildReasoningScript(ctx: ScenarioContext): ScriptStep[] {
  const { threadId, runId } = ctx
  const reasoningId = `rsn-${runId}`
  const steps: ScriptStep[] = [
    { delayMs: 0, event: { type: 'RUN_STARTED', threadId, runId } },
    { delayMs: 60, event: { type: 'REASONING_START', messageId: reasoningId } },
  ]

  for (let i = 0; i < REASONING.length; i += 10) {
    steps.push({
      delayMs: 26,
      event: {
        type: 'REASONING_MESSAGE_CONTENT',
        messageId: reasoningId,
        delta: REASONING.slice(i, i + 10),
      },
    })
  }

  steps.push({ delayMs: 40, event: { type: 'REASONING_END', messageId: reasoningId } })

  // 快照打底：界面第一次知道这份共享状态长什么样。
  steps.push({
    delayMs: 80,
    event: {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        task: '整理 2026 Q3 季度报告',
        quarter: 'Q3',
        basis: 'calendar',
        steps: [
          { name: '确认口径', done: true },
          { name: '查营收', done: false },
          { name: '查成本', done: false },
        ],
        metrics: {},
      },
    },
  })

  // 增量补丁：工作推进时只发变化的部分，不重发整份状态。
  steps.push({
    delayMs: 500,
    event: {
      type: 'STATE_DELTA',
      delta: [
        { op: 'replace', path: '/steps/1/done', value: true },
        { op: 'add', path: '/metrics/revenue', value: 1284000 },
      ],
    },
  })

  steps.push({
    delayMs: 450,
    event: {
      type: 'STATE_DELTA',
      delta: [
        { op: 'replace', path: '/steps/2/done', value: true },
        { op: 'add', path: '/metrics/cost', value: 903000 },
        { op: 'add', path: '/steps/-', value: { name: '算环比', done: true } },
      ],
    },
  })

  steps.push({
    delayMs: 300,
    event: {
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/metrics/qoq', value: 0.12 }],
    },
  })

  steps.push(...streamText(`msg-${runId}`, ANSWER))
  steps.push({
    delayMs: 40,
    event: { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } },
  })

  return steps
}

/**
 * 故意发一条打不上的补丁，用来练恢复路径。
 *
 * 这不是人为刁难：真实系统里丢包、乱序、服务端重启导致的版本漂移都会造成这种情况，
 * 界面必须能自己恢复而不是崩掉或者显示一份错的数据。
 */
export function buildBadPatchScript(ctx: ScenarioContext): ScriptStep[] {
  const { threadId, runId } = ctx
  return [
    { delayMs: 0, event: { type: 'RUN_STARTED', threadId, runId } },
    {
      delayMs: 60,
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: { task: '整理季度报告', steps: [{ name: '确认口径', done: true }], metrics: {} },
      },
    },
    {
      delayMs: 400,
      // 这条补丁指向一个本地根本不存在的路径：两边状态已经不一致了。
      event: {
        type: 'STATE_DELTA',
        delta: [{ op: 'replace', path: '/metrics/revenue/total', value: 1 }],
      },
    },
    {
      delayMs: 400,
      // 界面请求重新对齐之后，服务端补发一份完整快照。
      event: {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          task: '整理季度报告',
          steps: [
            { name: '确认口径', done: true },
            { name: '查营收', done: true },
          ],
          metrics: { revenue: 1284000 },
        },
      },
    },
    {
      delayMs: 40,
      event: { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } },
    },
  ]
}
