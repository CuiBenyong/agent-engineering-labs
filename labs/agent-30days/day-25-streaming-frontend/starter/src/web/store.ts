/**
 * 手写 store：没有 Redux、没有 Zustand、没有 UI 库。
 * 它只暴露 useSyncExternalStore 需要的两个东西——subscribe 与 getSnapshot——
 * 加上三个动作 send / stop / retry。
 *
 * 不引状态库的理由写在正文里：面试官关心的是你怎么管流式状态，不是你会用哪个库。
 */
import {
  type Attempt,
  consumeRun,
  createFlushScheduler,
  newAttempt,
  retryAttempt,
  startRun,
  type StartedRun,
  stopRun,
} from '../stream/client'
import { type AssistantTurn, decodeFrame, emptyTurn, reduceEvent } from '../stream/reduce'

export interface UserItem {
  kind: 'user'
  id: string
  text: string
}

export interface AssistantItem {
  kind: 'assistant'
  id: string
  turn: AssistantTurn
}

export type ChatItem = UserItem | AssistantItem

export interface ChatState {
  items: ChatItem[]
  busy: boolean
  canRetry: boolean
  error?: string
  /** 本轮实际提交了多少次渲染。和 token 数一比就知道节流有没有生效。 */
  flushCount: number
}

export interface ChatStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ChatState
  send(text: string): void
  stop(): void
  retry(): void
}

export function createChatStore(baseUrl = ''): ChatStore {
  let state: ChatState = { items: [], busy: false, canRetry: false, flushCount: 0 }
  const listeners = new Set<() => void>()

  // getSnapshot 必须返回稳定引用：每次现造一个新对象会让 React 判定「变了」而无限重渲染
  const setState = (patch: Partial<ChatState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  let controller: AbortController | null = null
  let lastAttempt: Attempt | null = null

  const patchTurn = (id: string, next: AssistantTurn): void => {
    setState({
      items: state.items.map((item) =>
        item.kind === 'assistant' && item.id === id ? { ...item, turn: next } : item
      ),
    })
  }

  const readTurn = (id: string): AssistantTurn | undefined => {
    const found = state.items.find((item) => item.kind === 'assistant' && item.id === id)
    return found?.kind === 'assistant' ? found.turn : undefined
  }

  async function run(attempt: Attempt): Promise<void> {
    setState({ busy: true, canRetry: false, error: undefined, flushCount: 0 })
    lastAttempt = attempt
    controller = new AbortController()

    let started: StartedRun
    try {
      started = await startRun(baseUrl, 's-1', attempt)
    } catch (err) {
      setState({ busy: false, canRetry: true, error: describe(err) })
      return
    }

    // 重试复用同一个 clientMessageId，所以气泡也复用同一个：重来一次，不是多一条
    const itemId = attempt.clientMessageId
    const fresh: AssistantItem = { kind: 'assistant', id: itemId, turn: emptyTurn(started.runId) }
    const exists = state.items.some((item) => item.kind === 'assistant' && item.id === itemId)
    setState({
      items: exists
        ? state.items.map((item) =>
            item.kind === 'assistant' && item.id === itemId ? fresh : item
          )
        : [...state.items, fresh],
    })

    // 打字机的节流出口：token 先攒着，30ms 交一批。不这么做，长回复下每秒几十次全量 diff。
    const scheduler = createFlushScheduler((batch) => {
      const turn = readTurn(itemId)
      if (!turn) return
      patchTurn(itemId, { ...turn, text: turn.text + batch })
      setState({ flushCount: state.flushCount + 1 })
    })

    const applyEvent = (event: string, payload: Record<string, unknown>): void => {
      const turn = readTurn(itemId)
      if (!turn) return
      patchTurn(itemId, reduceEvent(turn, event, payload))
    }

    try {
      await consumeRun({
        baseUrl,
        runId: started.runId,
        signal: controller.signal,
        onFrame(frame) {
          const decoded = decodeFrame(frame)
          if (!decoded) return
          if (decoded.event === 'model:delta') {
            // 文本进缓冲，序号照常推进，这样重连去重仍然成立
            const turn = readTurn(itemId)
            if (turn && typeof decoded.payload.seq === 'number') {
              patchTurn(itemId, { ...turn, status: 'streaming', lastSeq: decoded.payload.seq })
            }
            scheduler.push(String(decoded.payload.text ?? ''))
            return
          }
          // 非文本事件必须先把缓冲里的字倒出去，否则工具卡片会插到还没显示的文字前面
          scheduler.flushNow()
          applyEvent(decoded.event, decoded.payload as Record<string, unknown>)
        },
      })
      scheduler.flushNow()
      setState({ busy: false })
    } catch (err) {
      scheduler.flushNow()
      if (controller.signal.aborted) {
        // 打断不是失败：cancel 已经发出去了，等后端那条 run:end 也没意义，直接收尾
        setState({ busy: false, canRetry: true })
        return
      }
      setState({ busy: false, canRetry: true, error: describe(err) })
    } finally {
      scheduler.stop()
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
    send(text) {
      if (state.busy || text.trim() === '') return
      const attempt = newAttempt(text.trim())
      setState({
        items: [
          ...state.items,
          { kind: 'user', id: `u-${attempt.clientMessageId}`, text: attempt.text },
        ],
      })
      void run(attempt)
    },
    stop() {
      const active = state.items.at(-1)
      if (!controller || !active || active.kind !== 'assistant') return
      // 两步：中止读取 + 通知后端取消
      void stopRun(controller, baseUrl, active.turn.runId)
    },
    retry() {
      if (!lastAttempt || state.busy) return
      // 复用同一个幂等键：后端认出是同一句话，把已有的 run 接回来，不会重跑
      void run(retryAttempt(lastAttempt))
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
