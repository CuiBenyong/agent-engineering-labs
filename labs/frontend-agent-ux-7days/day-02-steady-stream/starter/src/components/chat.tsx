'use client'

import { memo, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { decodeEventStream } from '@/protocol/decode'
import { isKnownEvent, type AgentEvent } from '@/protocol/events'
import { createFrameBuffer } from '@/stream/frame-buffer'
import { useScrollAnchor } from '@/stream/use-scroll-anchor'
import { StreamingMarkdown } from './markdown'

type Message = {
  id: string
  role: string
  text: string
  streaming: boolean
}

type RunState = 'idle' | 'running' | 'error'

/** 渲染次数统计，用来量化 D2 的优化效果。生产代码里不需要这个。 */
type RenderStats = {
  messageRenders: number
  flushes: number
  deltas: number
}

const MessageItem = memo(function MessageItem({
  message,
  onRender,
}: {
  message: Message
  onRender: () => void
}) {
  onRender()
  return (
    <li className="message">
      <span className="role">{message.role}</span>
      <StreamingMarkdown text={message.text} />
      {message.streaming ? <span className="cursor" /> : null}
    </li>
  )
})

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [runState, setRunState] = useState<RunState>('idle')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [inject, setInject] = useState('burst')
  const [batched, setBatched] = useState(true)
  const [stats, setStats] = useState<RenderStats>({ messageRenders: 0, flushes: 0, deltas: 0 })
  const [, startTransition] = useTransition()

  const {
    ref: listRef,
    pinned,
    followIfPinned,
    scrollToBottom,
  } = useScrollAnchor<HTMLOListElement>()

  const runIdRef = useRef(0)
  const renderCountRef = useRef(0)
  const countRender = useCallback(() => {
    renderCountRef.current += 1
  }, [])

  // 内容变化后按锚定规则决定要不要跟随到底部。
  useEffect(() => {
    followIfPinned()
  }, [messages, followIfPinned])

  const appendDeltas = useCallback((batch: Array<{ messageId: string; delta: string }>) => {
    setMessages((prev) => {
      // 一帧内的增量先在本地合并成「每条消息一段文字」，
      // 再对消息数组做一次 map。否则 100 个增量就是 100 次数组遍历。
      const merged = new Map<string, string>()
      for (const item of batch) {
        merged.set(item.messageId, (merged.get(item.messageId) ?? '') + item.delta)
      }
      return prev.map((m) => {
        const addition = merged.get(m.id)
        return addition ? { ...m, text: m.text + addition } : m
      })
    })
  }, [])

  const send = useCallback(async () => {
    setRunState('running')
    setErrorText(null)
    renderCountRef.current = 0

    const runId = `run-${++runIdRef.current}`
    let deltaCount = 0

    const buffer = createFrameBuffer<{ messageId: string; delta: string }>({
      flush: (batch) => {
        // 流式内容是低优先级更新：用户此刻的输入、点击必须能插队。
        // 没有这一层，打字会明显卡在流后面。
        startTransition(() => appendDeltas(batch))
      },
    })

    const applyEvent = (event: AgentEvent) => {
      switch (event.type) {
        case 'TEXT_MESSAGE_START':
          setMessages((prev) => [
            ...prev,
            { id: event.messageId, role: event.role, text: '', streaming: true },
          ])
          return

        case 'TEXT_MESSAGE_CONTENT':
          deltaCount += 1
          if (batched) {
            buffer.push({ messageId: event.messageId, delta: event.delta })
          } else {
            // D1 的写法，留在这里做对照：每个增量一次 setState。
            appendDeltas([{ messageId: event.messageId, delta: event.delta }])
          }
          return

        case 'TEXT_MESSAGE_END':
          // 收尾前先把缓冲区排空，否则最后几个增量会丢。
          buffer.flushNow()
          setMessages((prev) =>
            prev.map((m) => (m.id === event.messageId ? { ...m, streaming: false } : m))
          )
          return

        case 'RUN_ERROR':
          setErrorText(`${event.message}${event.code ? `（${event.code}）` : ''}`)
          setRunState('error')
          return

        case 'RUN_FINISHED':
          setRunState('idle')
          return

        default:
          return
      }
    }

    try {
      const res = await fetch(`/api/agent?inject=${inject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 'thread-demo', runId }),
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
      // 等一帧让最后的渲染落地，再读统计。
      requestAnimationFrame(() => {
        setStats({
          messageRenders: renderCountRef.current,
          flushes: buffer.flushCount,
          deltas: deltaCount,
        })
        buffer.dispose()
      })
    }
  }, [appendDeltas, batched, inject])

  return (
    <div className="chat">
      <div className="toolbar">
        <button type="button" onClick={send} disabled={runState === 'running'}>
          {runState === 'running' ? '接收中…' : '发送'}
        </button>

        <label>
          故障注入
          <select value={inject} onChange={(e) => setInject(e.target.value)}>
            <option value="none">none（正常）</option>
            <option value="slow">slow（慢速）</option>
            <option value="burst">burst（风暴）</option>
            <option value="cut">cut（断流）</option>
            <option value="error">error（报错）</option>
          </select>
        </label>

        <label className="switch">
          <input type="checkbox" checked={batched} onChange={(e) => setBatched(e.target.checked)} />
          按帧合并
        </label>

        <button type="button" onClick={() => setMessages([])}>
          清空
        </button>
      </div>

      {/* 用来实测「流式会不会把输入卡住」：流跑起来的时候在这里打字。 */}
      <input
        className="typing-probe"
        type="text"
        placeholder="流式期间在这里打字，感受输入有没有被拖卡"
        aria-label="输入延迟测试框"
      />

      <p className="stats" data-testid="stats">
        增量 <b data-testid="stat-deltas">{stats.deltas}</b> 个 · 状态更新{' '}
        <b data-testid="stat-flushes">{stats.flushes}</b> 次 · 消息组件渲染{' '}
        <b data-testid="stat-renders">{stats.messageRenders}</b> 次
      </p>

      {errorText ? <p className="error">出错了：{errorText}</p> : null}

      <ol className="messages" ref={listRef}>
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} onRender={countRender} />
        ))}
      </ol>

      {!pinned ? (
        <button type="button" className="jump" onClick={scrollToBottom}>
          回到底部
        </button>
      ) : null}

      {messages.length === 0 ? <p className="hint">点「发送」开始。</p> : null}
    </div>
  )
}
