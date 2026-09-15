'use client'

import { memo, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { decodeEventStream } from '@/protocol/decode'
import { isKnownEvent, type AgentEvent } from '@/protocol/events'
import { createFrameBuffer } from '@/stream/frame-buffer'
import { useScrollAnchor } from '@/stream/use-scroll-anchor'
import {
  appendArgs,
  applyResult,
  createToolCall,
  finalizeArgs,
  type ToolCall,
} from '@/stream/tool-calls'
import { StreamingMarkdown } from './markdown'
import { ToolCallCard, type ToolDecision } from './tool-call-card'

type Message = {
  id: string
  role: string
  text: string
  streaming: boolean
}

/** 时间线上的一项：要么是一条消息，要么是一次工具调用。 */
type TimelineItem = { kind: 'message'; id: string } | { kind: 'tool'; id: string }

type RunState = 'idle' | 'running' | 'error'

type PendingInterrupt = {
  interruptId: string
  toolCallId: string
  reason?: string
  payload?: unknown
}

const MessageItem = memo(function MessageItem({ message }: { message: Message }) {
  return (
    <li className="message">
      <span className="role">{message.role}</span>
      <StreamingMarkdown text={message.text} />
      {message.streaming ? <span className="cursor" /> : null}
    </li>
  )
})

export function Chat() {
  const [messages, setMessages] = useState<Record<string, Message>>({})
  const [toolCalls, setToolCalls] = useState<Record<string, ToolCall>>({})
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [runState, setRunState] = useState<RunState>('idle')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [inject, setInject] = useState('none')
  const [pending, setPending] = useState<PendingInterrupt | null>(null)
  const [, startTransition] = useTransition()

  const {
    ref: listRef,
    pinned,
    followIfPinned,
    scrollToBottom,
  } = useScrollAnchor<HTMLOListElement>()
  const runIdRef = useRef(0)

  useEffect(() => {
    followIfPinned()
  }, [messages, toolCalls, followIfPinned])

  const appendDeltas = useCallback((batch: Array<{ messageId: string; delta: string }>) => {
    setMessages((prev) => {
      const next = { ...prev }
      for (const { messageId, delta } of batch) {
        const m = next[messageId]
        if (m) next[messageId] = { ...m, text: m.text + delta }
      }
      return next
    })
  }, [])

  /** 跑一次运行。resume 非空时表示这是带着用户决定的续跑。 */
  const run = useCallback(
    async (
      resume?: Array<{ interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown }>
    ) => {
      setRunState('running')
      setErrorText(null)

      const runId = `run-${++runIdRef.current}`
      const buffer = createFrameBuffer<{ messageId: string; delta: string }>({
        flush: (batch) => startTransition(() => appendDeltas(batch)),
      })

      const applyEvent = (event: AgentEvent) => {
        switch (event.type) {
          case 'TEXT_MESSAGE_START':
            setMessages((prev) => ({
              ...prev,
              [event.messageId]: {
                id: event.messageId,
                role: event.role,
                text: '',
                streaming: true,
              },
            }))
            setTimeline((prev) => [...prev, { kind: 'message', id: event.messageId }])
            return

          case 'TEXT_MESSAGE_CONTENT':
            buffer.push({ messageId: event.messageId, delta: event.delta })
            return

          case 'TEXT_MESSAGE_END':
            buffer.flushNow()
            setMessages((prev) => {
              const m = prev[event.messageId]
              return m ? { ...prev, [event.messageId]: { ...m, streaming: false } } : prev
            })
            return

          // --- 工具调用的四段 ---

          case 'TOOL_CALL_START':
            setToolCalls((prev) => ({
              ...prev,
              [event.toolCallId]: createToolCall(
                event.toolCallId,
                event.toolCallName,
                event.parentMessageId
              ),
            }))
            setTimeline((prev) => [...prev, { kind: 'tool', id: event.toolCallId }])
            return

          case 'TOOL_CALL_ARGS':
            // 参数一片片来，这里只累加原文，不 parse——半截 JSON parse 必炸。
            setToolCalls((prev) => {
              const call = prev[event.toolCallId]
              return call ? { ...prev, [event.toolCallId]: appendArgs(call, event.delta) } : prev
            })
            return

          case 'TOOL_CALL_END':
            // 参数收齐，现在才 parse。
            setToolCalls((prev) => {
              const call = prev[event.toolCallId]
              return call ? { ...prev, [event.toolCallId]: finalizeArgs(call) } : prev
            })
            return

          case 'TOOL_CALL_RESULT':
            setToolCalls((prev) => {
              const call = prev[event.toolCallId]
              return call ? { ...prev, [event.toolCallId]: applyResult(call, event.content) } : prev
            })
            return

          case 'RUN_ERROR':
            setErrorText(`${event.message}${event.code ? `（${event.code}）` : ''}`)
            setRunState('error')
            return

          case 'RUN_FINISHED': {
            // 【练习 4】处理中断式结束。
            //
            // event.outcome 的 type 为 'interrupt' 时，说明这次运行**真的结束了**，
            // 只不过结束方式是「等人做决定」。前端要：
            //   1. 记下 interruptId 与 payload（下一次请求要带回去）
            //   2. 把对应的工具卡片状态改成 awaiting-approval
            //
            // 注意不要理解成「流挂起在等前端」——流已经关了。
            setRunState('idle')
            return
          }

          default:
            return
        }
      }

      try {
        const res = await fetch(`/api/agent?inject=${inject}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: 'thread-demo', runId, resume }),
        })

        for await (const event of decodeEventStream(res)) {
          if (isKnownEvent(event)) applyEvent(event)
        }

        buffer.flushNow()
        setRunState((prev) => (prev === 'running' ? 'idle' : prev))
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error))
        setRunState('error')
      } finally {
        buffer.dispose()
      }
    },
    [appendDeltas, inject]
  )

  const decide = useCallback(
    (decision: ToolDecision) => {
      if (!pending) return
      setPending(null)
      // 【练习 5】把用户的决定发回服务端。
      //
      // 关键认知：决定不在本地生效，而是作为下一次请求的 resume 条目发回去，
      // 由服务端决定要不要真的执行。前端的审批界面只是采集决定，
      // 它拦不住任何东西——改改请求就绕过去了。
      void decision
      void run
    },
    [pending, run]
  )

  return (
    <div className="chat">
      <div className="toolbar">
        <button type="button" onClick={() => run()} disabled={runState === 'running'}>
          {runState === 'running' ? '接收中…' : '发送'}
        </button>

        <label>
          剧本
          <select value={inject} onChange={(e) => setInject(e.target.value)}>
            <option value="none">只读工具（不需审批）</option>
            <option value="interrupt">危险工具（需要审批）</option>
            <option value="error">报错</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() => {
            setMessages({})
            setToolCalls({})
            setTimeline([])
            setPending(null)
          }}
        >
          清空
        </button>
      </div>

      {errorText ? <p className="error">出错了：{errorText}</p> : null}

      <ol className="messages" ref={listRef}>
        {timeline.map((item) =>
          item.kind === 'message' ? (
            messages[item.id] ? (
              <MessageItem key={`m-${item.id}`} message={messages[item.id]} />
            ) : null
          ) : toolCalls[item.id] ? (
            <li key={`t-${item.id}`}>
              <ToolCallCard call={toolCalls[item.id]} onDecision={decide} />
            </li>
          ) : null
        )}
      </ol>

      {!pinned ? (
        <button type="button" className="jump" onClick={scrollToBottom}>
          回到底部
        </button>
      ) : null}

      {timeline.length === 0 ? <p className="hint">点「发送」开始。</p> : null}
    </div>
  )
}
