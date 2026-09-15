/**
 * D5 新增剧本：生成式界面。
 * 独立文件，不动冻结的 scenarios.ts。
 *
 * 生成式内容走 CUSTOM 事件：协议不可能为每种界面都定一个事件类型，
 * CUSTOM 就是给这类应用层扩展留的口子。name 区分用途，value 装载荷。
 */

import type { ScenarioContext, ScriptStep } from './scenarios'

const METRIC = {
  component: 'metric',
  props: { label: '本季营收', value: 1284000, unit: '元' },
}

const TABLE = {
  component: 'table',
  props: {
    columns: ['科目', '金额', '环比'],
    rows: [
      ['营收', '1,284,000', '+12%'],
      ['成本', '903,000', '+4%'],
    ],
  },
}

const CHOICES = {
  component: 'choices',
  props: { question: '接下来做什么？', options: ['导出 PDF', '发给财务', '再算一遍'] },
}

/** 声明式范式的界面描述：一棵节点树。 */
const DECLARATIVE_TREE = {
  type: 'stack',
  children: [
    { type: 'heading', text: '2026 Q3 摘要' },
    {
      type: 'row',
      children: [
        { type: 'badge', text: '已复核' },
        { type: 'text', text: '数据来自财务系统导出' },
      ],
    },
    { type: 'divider' },
    { type: 'text', text: '营收环比增长 12%，成本增长 4%，毛利率改善。' },
  ],
}

function text(messageId: string, body: string): ScriptStep[] {
  const steps: ScriptStep[] = [
    { delayMs: 50, event: { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' } },
  ]
  for (let i = 0; i < body.length; i += 8) {
    steps.push({
      delayMs: 22,
      event: { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: body.slice(i, i + 8) },
    })
  }
  steps.push({ delayMs: 30, event: { type: 'TEXT_MESSAGE_END', messageId } })
  return steps
}

/** 正常剧本：文字 + 三个静态生成式组件 + 一棵声明式树。 */
export function buildGenerativeScript(ctx: ScenarioContext): ScriptStep[] {
  const { threadId, runId } = ctx
  return [
    { delayMs: 0, event: { type: 'RUN_STARTED', threadId, runId } },
    ...text(`msg-${runId}-a`, '季度数据整理好了，重点如下。'),
    { delayMs: 120, event: { type: 'CUSTOM', name: 'ui.component', value: METRIC } },
    { delayMs: 200, event: { type: 'CUSTOM', name: 'ui.component', value: TABLE } },
    { delayMs: 200, event: { type: 'CUSTOM', name: 'ui.declarative', value: DECLARATIVE_TREE } },
    ...text(`msg-${runId}-b`, '需要我继续处理吗？'),
    { delayMs: 120, event: { type: 'CUSTOM', name: 'ui.component', value: CHOICES } },
    {
      delayMs: 40,
      event: { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } },
    },
  ]
}

/**
 * 兜底剧本：模型给出未注册组件、非法数据、以及一棵含非法节点的树。
 *
 * 这三种情况在真实系统里都会发生，而且不需要任何恶意：
 * 模型看错了注册表说明、字段拼错、上游加了新组件而前端没跟上，都足够了。
 */
export function buildUnknownComponentScript(ctx: ScenarioContext): ScriptStep[] {
  const { threadId, runId } = ctx
  return [
    { delayMs: 0, event: { type: 'RUN_STARTED', threadId, runId } },
    ...text(`msg-${runId}-a`, '这里有几个我暂时渲染不了的东西。'),
    // 1. 注册表里没有的组件
    {
      delayMs: 120,
      event: {
        type: 'CUSTOM',
        name: 'ui.component',
        value: { component: 'timeline_3d', props: { events: [] } },
      },
    },
    // 2. 组件名对但数据不合法（value 应该是数字）
    {
      delayMs: 160,
      event: {
        type: 'CUSTOM',
        name: 'ui.component',
        value: { component: 'metric', props: { label: '营收', value: '一百二十八万' } },
      },
    },
    // 3. 声明式树里混了一个非法节点：其余部分必须照常渲染
    {
      delayMs: 160,
      event: {
        type: 'CUSTOM',
        name: 'ui.declarative',
        value: {
          type: 'stack',
          children: [
            { type: 'heading', text: '仍然可用的部分' },
            { type: 'script', text: 'alert(1)' },
            { type: 'text', text: '这一行应该正常显示。' },
          ],
        },
      },
    },
    // 4. 正常组件收尾：证明前面的失败没有影响后续渲染
    { delayMs: 160, event: { type: 'CUSTOM', name: 'ui.component', value: METRIC } },
    {
      delayMs: 40,
      event: { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } },
    },
  ]
}
