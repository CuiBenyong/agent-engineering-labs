/**
 * 事件 → 界面状态的归并：同样是纯函数，不 import 任何 React 的东西。
 *
 * 事件名沿用 D5 定的那一套，一个都不新造：
 * run:start / run:end / run:error / model:delta /
 * tool:proposed / approval:required / tool:start / tool:end / tool:error
 */
import type { SseFrame } from './parse'

export type ToolStatus = 'proposed' | 'running' | 'done' | 'error'
export type TurnStatus = 'pending' | 'streaming' | 'done' | 'cancelled' | 'error'

/** 一次工具调用在界面上就是一张卡片。三个事件归并到同一张，靠 callId。 */
export interface ToolCard {
  callId: string
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  approvalRequired: boolean
  result?: string
  ms?: number
  error?: string
}

/** 助手的一轮回答。text 是打字机区域，tools 是穿插其中的卡片。 */
export interface AssistantTurn {
  runId: string
  text: string
  tools: ToolCard[]
  status: TurnStatus
  /** 已经归并进来的最大序号。小于等于它的事件一律丢弃——D11 保序器的同一条纪律。 */
  lastSeq: number
  error?: string
}

export function emptyTurn(runId: string): AssistantTurn {
  return { runId, text: '', tools: [], status: 'pending', lastSeq: -1 }
}

interface EventPayload {
  runId?: string
  seq?: number
  text?: string
  callId?: string
  tool?: string
  args?: Record<string, unknown>
  result?: string
  ms?: number
  message?: string
  status?: string
}

/** 把一帧解成 (事件名, 负载)。data 不是合法 JSON 就整帧丢掉，别让界面跟着炸。 */
export function decodeFrame(frame: SseFrame): { event: string; payload: EventPayload } | null {
  try {
    return { event: frame.event, payload: JSON.parse(frame.data) as EventPayload }
  } catch {
    return null
  }
}

function upsertTool(tools: ToolCard[], callId: string, patch: Partial<ToolCard>): ToolCard[] {
  // 练习 2：这个版本每来一个 tool:* 事件就新加一张卡片，
  //   于是一次工具调用在界面上变成三张卡片（proposed / running / done 各一张）。
  //   请改成按 callId 归并：找得到就合并字段，找不到才新建。
  //   提示：tool:start 可能先于 tool:proposed 到达（重连回放），找不到时要补一张而不是丢掉事件。
  const created: ToolCard = {
    callId,
    name: '未知工具',
    args: {},
    status: 'running',
    approvalRequired: false,
    ...patch,
  }
  return [...tools, created]
}

/**
 * 归并一条事件。纯函数：输入旧状态 + 事件，输出新状态，不改参数、不碰全局。
 * 面试里被追问「流式状态怎么管」时，能把这个签名说出来就已经赢一半了。
 */
export function reduceEvent(
  turn: AssistantTurn,
  event: string,
  payload: EventPayload
): AssistantTurn {
  const seq = payload.seq ?? -1
  // 重连回放与流上的片段必然重叠，靠这一句去重（D11）
  if (seq >= 0 && seq <= turn.lastSeq) return turn
  const base = seq >= 0 ? { ...turn, lastSeq: seq } : { ...turn }

  switch (event) {
    case 'run:start':
      return { ...base, status: 'streaming' }

    case 'model:delta':
      return { ...base, status: 'streaming', text: base.text + (payload.text ?? '') }

    case 'tool:proposed':
      return {
        ...base,
        tools: upsertTool(base.tools, payload.callId ?? '', {
          callId: payload.callId ?? '',
          name: payload.tool ?? '未知工具',
          args: payload.args ?? {},
          status: 'proposed',
          approvalRequired: false,
        }),
      }

    case 'approval:required':
      return {
        ...base,
        tools: upsertTool(base.tools, payload.callId ?? '', { approvalRequired: true }),
      }

    case 'tool:start':
      return { ...base, tools: upsertTool(base.tools, payload.callId ?? '', { status: 'running' }) }

    case 'tool:end':
      return {
        ...base,
        tools: upsertTool(base.tools, payload.callId ?? '', {
          status: 'done',
          result: payload.result,
          ms: payload.ms,
        }),
      }

    case 'tool:error':
      return {
        ...base,
        tools: upsertTool(base.tools, payload.callId ?? '', {
          status: 'error',
          error: payload.message,
        }),
      }

    case 'run:end':
      return { ...base, status: payload.status === 'cancelled' ? 'cancelled' : 'done' }

    case 'run:error':
      return { ...base, status: 'error', error: payload.message ?? '未知错误' }

    default:
      return base
  }
}
