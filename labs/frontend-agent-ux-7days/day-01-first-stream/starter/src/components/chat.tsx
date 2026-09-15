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
    // 【练习 4】把事件应用到界面状态上。
    //   TEXT_MESSAGE_START   新建一条消息（streaming 为 true）
    //   TEXT_MESSAGE_CONTENT 按 messageId 找到那条消息，把 delta 追加到 text 后面
    //   TEXT_MESSAGE_END     把那条消息的 streaming 改成 false
    //   RUN_ERROR            显示错误并把 runState 设成 error
    //   RUN_FINISHED         把 runState 设回 idle
    //   其余                 静静跳过（不要 throw）
    switch (event.type) {
      default:
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
        // 【练习 5】认识的事件交给 applyEvent；不认识的**忽略**并在开发模式打日志。
        //
        // 想清楚为什么不能 throw：协议还在演进，后端加一个新事件
        // 不应该打挂所有还没跟上的前端。剧本里就埋了一个未知事件，
        // 写成报错的话页面会在流的末尾崩掉。
        void isKnownEvent
        applyEvent(event as AgentEvent)
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
