/**
 * 【冻结文件 · D1 定稿】D2–D7 逐字复制（后续天数只允许往 SCENARIOS 里加剧本，
 * 不允许改已有剧本与 INJECT 取值）。
 * 改动后必须跑 bash scripts/check-feux-consistency.sh 复验一致性。
 *
 * 离线剧本：本课默认不连真实模型。
 *
 * 理由：这门课教的是「收到事件之后界面怎么办」，真实模型只会带来两样东西——
 * 不确定性（每次吐的内容都不一样，没法写断言）和 API Key 门槛（挡住一半读者）。
 * 想接真模型的读者看 D7 的说明，但那不是必做项。
 */

import type { AgentEvent, BaseEvent } from '../protocol/events'

/** 全课统一的故障开关，取值表见连贯性卡片 §3.2，不许自造新值。 */
export type InjectMode =
  | 'none'
  /** 每个增量之间 sleep 80ms，用来看渲染抖动 */
  | 'slow'
  /** 一次性吐 200 个增量，用来复现渲染风暴 */
  | 'burst'
  /** 流到一半直接断，用来练断线续播 */
  | 'cut'
  /** 吐一个 RUN_ERROR */
  | 'error'
  /** 工具调用前中断等审批 */
  | 'interrupt'
  /** 生成式组件给一个未注册的类型 */
  | 'unknown-component'

export const INJECT_MODES: InjectMode[] = [
  'none',
  'slow',
  'burst',
  'cut',
  'error',
  'interrupt',
  'unknown-component',
]

export function parseInject(value: string | undefined | null): InjectMode {
  const mode = (value ?? 'none') as InjectMode
  return INJECT_MODES.includes(mode) ? mode : 'none'
}

export type ScenarioContext = {
  threadId: string
  runId: string
  inject: InjectMode
}

/**
 * 协议里没定义过的事件。它不是恶作剧：上游协议还在加新事件，
 * 真实世界里前端迟早会收到没见过的类型，必须能忽略它继续工作。
 */
export type UnknownUpstreamEvent = BaseEvent & { [key: string]: unknown }

/** 每一步是一个事件，外加它之前要等多久（毫秒）。 */
export type ScriptStep = {
  delayMs: number
  event: AgentEvent | UnknownUpstreamEvent
}

const REPLY_TEXT =
  '同声传译的难处不在词汇量，而在于必须在信息不完整的时候就开口。' +
  '流式界面也是一样：整句话还没成形，你就得把它显示出来。'

/** 把一段文字切成若干增量，模拟模型逐词吐字。 */
function toDeltas(text: string, size: number): string[] {
  const deltas: string[] = []
  for (let i = 0; i < text.length; i += size) {
    deltas.push(text.slice(i, i + size))
  }
  return deltas
}

/**
 * D1 的基础剧本：开场 → 一条流式消息 → 收尾。
 * 后面几天会在这个基础上加工具调用、推理、状态等剧本。
 */
export function buildBasicScript(ctx: ScenarioContext): ScriptStep[] {
  const { threadId, runId, inject } = ctx
  const messageId = `msg-${runId}`
  const steps: ScriptStep[] = []

  steps.push({
    delayMs: 0,
    event: { type: 'RUN_STARTED', threadId, runId, timestamp: Date.now() },
  })

  // error 模式：开场之后直接失败，用来验界面的错误态而不是永远转圈。
  if (inject === 'error') {
    steps.push({
      delayMs: 120,
      event: {
        type: 'RUN_ERROR',
        message: '模型服务暂时不可用，请稍后重试',
        code: 'provider_unavailable',
      },
    })
    return steps
  }

  steps.push({
    delayMs: 80,
    event: { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
  })

  // burst 模式把同一段文字切得极碎，用来复现渲染风暴（D2 的主角）。
  //
  // 注意 burst 的间隔是 2ms 而不是 0：这一条是实测出来的，不是拍脑袋。
  // 间隔为 0 时整条流几乎在一两个数据块里到达，客户端在同一个事件循环 tick 里
  // 连续 setState，**React 的自动批处理会把它们合并成一两次渲染**，
  // 风暴根本不会发生（实测 174 个增量只渲染 6 次）。
  // 真实的风暴来自增量跨事件循环陆续到达，所以必须留一个真实的微小间隔。
  const chunkSize = inject === 'burst' ? 1 : 4
  const perDelta = inject === 'slow' ? 80 : inject === 'burst' ? 2 : 24
  const deltas = toDeltas(inject === 'burst' ? REPLY_TEXT.repeat(3) : REPLY_TEXT, chunkSize)

  deltas.forEach((delta, index) => {
    steps.push({
      delayMs: index === 0 ? 60 : perDelta,
      event: { type: 'TEXT_MESSAGE_CONTENT', messageId, delta },
    })
  })

  steps.push({ delayMs: 40, event: { type: 'TEXT_MESSAGE_END', messageId } })
  steps.push({
    delayMs: 40,
    event: {
      type: 'RUN_FINISHED',
      threadId,
      runId,
      outcome: { type: 'success' },
    },
  })

  // 前端必须忽略它并继续工作，不能崩。自检里有一条断言专门盯这个。
  steps.push({
    delayMs: 10,
    event: { type: 'FUTURE_EVENT_FROM_UPSTREAM', note: 'forward compatibility check' },
  })

  return steps
}

/** cut 模式：把剧本从中间截断，模拟流断在一半。 */
export function applyCut(steps: ScriptStep[], inject: InjectMode): ScriptStep[] {
  if (inject !== 'cut') return steps
  return steps.slice(0, Math.max(3, Math.floor(steps.length / 2)))
}

export function buildScript(ctx: ScenarioContext): ScriptStep[] {
  return applyCut(buildBasicScript(ctx), ctx.inject)
}
