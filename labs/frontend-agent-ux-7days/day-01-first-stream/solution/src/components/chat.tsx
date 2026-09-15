'use client'

import { useCallback, useRef, useState } from 'react'
import { decodeEventStream } from '@/protocol/decode'
import { isKnownEvent, type AgentEvent } from '@/protocol/events'

type Message = {
  id: string
  role: string
  text: string
  /** 还在流式接收中，界面上用它显示光标 */
  streaming: boolean
}

type RunState = 'idle' | 'running' | 'error'

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [runState, setRunState] = useState<RunState>('idle')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [inject, setInject] = useState('none')
  const runIdRef = useRef(0)

  /**
   * D1 的写法：每收到一个增量就 setState 一次。
   * 这是最直白的实现，也是 D2 要推翻的那一版——
   * 模型每秒吐几十上百个增量时，它会让 React 疯狂重渲染。
   * 先把能跑的基线做出来，才有东西可测量。
   */
  const applyEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'TEXT_MESSAGE_START':
        setMessages((prev) => [
          ...prev,
          { id: event.messageId, role: event.role, text: '', streaming: true },
        ])
        return

      case 'TEXT_MESSAGE_CONTENT':
        setMessages((prev) =>
          prev.map((m) => (m.id === event.messageId ? { ...m, text: m.text + event.delta } : m))
        )
        return

      case 'TEXT_MESSAGE_END':
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
        // 认识但这一天还用不到的事件（工具、推理、状态……），静静跳过。
        return
    }
  }, [])

  const send = useCallback(async () => {
    setRunState('running')
    setErrorText(null)

    const runId = `run-${++runIdRef.current}`

    try {
      const res = await fetch(`/api/agent?inject=${inject}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 'thread-demo', runId }),
      })

      for await (const event of decodeEventStream(res)) {
        if (isKnownEvent(event)) {
          applyEvent(event)
        } else if (process.env.NODE_ENV !== 'production') {
          // 未知事件类型必须忽略而不是报错：协议在演进，
          // 后端加一个新事件不应该打挂还没跟上的前端。
          console.debug('[agent] 未处理的事件类型', event.type)
        }
      }

      // 流正常结束但没收到 RUN_FINISHED（比如被 cut 截断），
      // 界面也要回到可操作状态，不能一直卡在 running。
      setRunState((prev) => (prev === 'running' ? 'idle' : prev))
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
      setRunState('error')
    }
  }, [applyEvent, inject])

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

        <button type="button" onClick={() => setMessages([])}>
          清空
        </button>
      </div>

      {errorText ? <p className="error">出错了：{errorText}</p> : null}

      <ol className="messages">
        {messages.map((m) => (
          <li key={m.id} className="message">
            <span className="role">{m.role}</span>
            <p>
              {m.text}
              {m.streaming ? <span className="cursor" /> : null}
            </p>
          </li>
        ))}
      </ol>

      {messages.length === 0 ? <p className="hint">点「发送」看第一条流。</p> : null}
    </div>
  )
}
