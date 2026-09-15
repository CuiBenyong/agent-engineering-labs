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
import { applyPatch, type JsonPatchOperation } from '@/stream/json-patch'
import type { ComponentSpec, UiNode } from '@/stream/generative'
import { ResumeTracker, stopRun } from '@/stream/resume'
import {
  activePath,
  addItem,
  appendTurn,
  branchInfo,
  createTree,
  editAndResend,
  switchBranch,
  type SessionTree,
} from '@/stream/session-tree'
import { createAnnouncer } from '@/stream/announcer'
import type { Measurement } from '@/stream/budget'
import { BudgetPanel } from './budget-panel'
import { LiveRegion, useAnnouncementQueue } from './live-region'
import { RunProgress, type StepState } from './run-progress'
import { SubagentPanel, type Subagent } from './subagent-panel'
import { DeclarativeBlock, GenerativeBlock } from './generative-block'
import { StreamingMarkdown } from './markdown'
import { ReasoningPanel, type Reasoning } from './reasoning-panel'
import { StateInspector } from './state-inspector'
import { ToolCallCard, type ToolDecision } from './tool-call-card'

type Message = {
  id: string
  role: string
  text: string
  streaming: boolean
}

/** 时间线上的一项：要么是一条消息，要么是一次工具调用。 */
type TimelineItem =
  | { kind: 'message'; id: string }
  | { kind: 'tool'; id: string }
  | { kind: 'reasoning'; id: string }
  | { kind: 'generated'; id: string }

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
  const [reasonings, setReasonings] = useState<Record<string, Reasoning>>({})
  const [sharedState, setSharedState] = useState<Record<string, unknown> | null>(null)
  const [generated, setGenerated] = useState<
    Record<
      string,
      { kind: 'component'; spec: ComponentSpec } | { kind: 'declarative'; tree: UiNode }
    >
  >({})
  const genSeq = useRef(0)
  const [tree, setTree] = useState<SessionTree>(() => createTree())
  const [steps, setSteps] = useState<StepState[]>([])
  const [subagents, setSubagents] = useState<Record<string, Subagent>>({})
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [stoppedNote, setStoppedNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const trackerRef = useRef(new ResumeTracker())
  const announcements = useAnnouncementQueue()
  const announcerRef = useRef<ReturnType<typeof createAnnouncer> | null>(null)
  const [measurement, setMeasurement] = useState<Measurement>({
    timeToFirstTokenMs: null,
    longestTaskMs: 0,
    updatesPerSecond: 0,
    domNodes: 0,
  })
  const sendStartRef = useRef(0)
  const updateCountRef = useRef(0)
  const [stateStale, setStateStale] = useState(false)
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
    updateCountRef.current += 1
    setMessages((prev) => {
      const next = { ...prev }
      for (const { messageId, delta } of batch) {
        const m = next[messageId]
        if (m) next[messageId] = { ...m, text: m.text + delta }
      }

      // 播报**不**指向流式渲染的那个元素：那样要么每来一个增量就重念整段，
      // 要么被屏幕阅读器整个跳过。这里把完整文本喂给分段器，
      // 由它在句子完成时才推一段进实时区域。
      const last = batch[batch.length - 1]
      const target = last ? next[last.messageId] : undefined
      if (target) announcerRef.current?.update(target.text)

      return next
    })
  }, [])

  /** 跑一次运行。resume 非空时表示这是带着用户决定的续跑。 */
  const run = useCallback(
    async (
      resume?: Array<{ interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown }>,
      resumeFrom?: number
    ) => {
      setRunState('running')
      setErrorText(null)

      const runId = `run-${++runIdRef.current}`
      const startedAt = performance.now()
      sendStartRef.current = startedAt
      updateCountRef.current = 0
      announcerRef.current = createAnnouncer({ emit: (text) => announcements.push(text) })
      const controller = new AbortController()
      abortRef.current = controller
      const buffer = createFrameBuffer<{ messageId: string; delta: string }>({
        flush: (batch) => startTransition(() => appendDeltas(batch)),
      })

      const applyEvent = (event: AgentEvent) => {
        switch (event.type) {
          // --- 长任务进度 ---
          //
          // 刻意不画百分比：你不知道总共有几步，假装知道会得到一个
          // 走到 90% 就卡住的进度条，那比没有更伤信任。
          case 'STEP_STARTED':
            setSteps((prev) =>
              prev.some((s) => s.name === event.stepName)
                ? prev
                : [...prev, { name: event.stepName, done: false }]
            )
            return

          case 'STEP_FINISHED':
            setSteps((prev) =>
              prev.map((s) => (s.name === event.stepName ? { ...s, done: true } : s))
            )
            return

          // --- 子 Agent ---
          //
          // 归组靠 subagentRunId。两个子 Agent 的事件是交错到达的，
          // 按顺序拼一定串台——和消息靠 messageId、工具靠 toolCallId 同一个套路。
          case 'SUBAGENT_STARTED':
            setSubagents((prev) => ({
              ...prev,
              [event.subagentRunId]: {
                id: event.subagentRunId,
                name: event.name,
                description: event.description,
                done: false,
                text: '',
              },
            }))
            return

          case 'SUBAGENT_FINISHED':
            setSubagents((prev) => {
              const a = prev[event.subagentRunId]
              return a ? { ...prev, [event.subagentRunId]: { ...a, done: true } } : prev
            })
            return

          case 'TEXT_MESSAGE_START':
            // 属于某个子 Agent 的消息不进主时间线，进它自己的区域
            if (event.subagentRunId) return
            // 播报器按「一条消息」为单位追踪进度，新消息开始时必须重置。
            // 不重置的话，第二条消息会沿用第一条的已播报偏移量，
            // 开头一截被当成「已经念过」而跳过——实测时第二句被切成了「速高于行业均值。」
            announcerRef.current?.reset()
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
            setTree((prev) => addItem(prev, event.messageId))
            return

          case 'TEXT_MESSAGE_CONTENT':
            if (sendStartRef.current > 0) {
              // 首字延迟：用户点发送到看见第一个字。Agent 界面最关键的一条。
              setMeasurement((m) => ({
                ...m,
                timeToFirstTokenMs: Math.round(performance.now() - sendStartRef.current),
              }))
              sendStartRef.current = 0
            }
            if (event.subagentRunId) {
              const subId = event.subagentRunId
              setSubagents((prev) => {
                const a = prev[subId]
                return a ? { ...prev, [subId]: { ...a, text: a.text + event.delta } } : prev
              })
              return
            }
            buffer.push({ messageId: event.messageId, delta: event.delta })
            return

          // --- 推理过程 ---
          //
          // 用和文本消息一样的三段式，但**必须存在另一个地方**：
          // 混进消息里的话，推理的试错和自我否定会被读成最终答案。

          case 'REASONING_START':
            setReasonings((prev) => ({
              ...prev,
              [event.messageId]: { id: event.messageId, text: '', streaming: true },
            }))
            setTimeline((prev) => [...prev, { kind: 'reasoning', id: event.messageId }])
            return

          case 'REASONING_MESSAGE_CONTENT':
            setReasonings((prev) => {
              const r = prev[event.messageId]
              return r ? { ...prev, [event.messageId]: { ...r, text: r.text + event.delta } } : prev
            })
            return

          case 'REASONING_END':
            setReasonings((prev) => {
              const r = prev[event.messageId]
              return r ? { ...prev, [event.messageId]: { ...r, streaming: false } } : prev
            })
            return

          // --- 共享状态 ---

          case 'STATE_SNAPSHOT':
            // 快照是权威的：直接覆盖，并清掉「不同步」标记。
            setSharedState(
              typeof event.snapshot === 'object' && event.snapshot !== null
                ? (event.snapshot as Record<string, unknown>)
                : null
            )
            setStateStale(false)
            return

          case 'STATE_DELTA':
            setSharedState((prev) => {
              if (prev === null) {
                // 没有快照打底就收到补丁，说明漏了开头。不要凭空造一个状态。
                setStateStale(true)
                return prev
              }
              const result = applyPatch(prev, event.delta as JsonPatchOperation[])
              if (!result.ok) {
                // 补丁打不上是**可预期**的（丢包、乱序、版本漂移），不是 bug。
                // 正确反应是标记不同步并请求重新对齐，而不是崩掉，
                // 更不是显示一份改了一半的数据。
                if (process.env.NODE_ENV !== 'production') {
                  console.warn('[agent] 补丁打不上，等待重新对齐', result.error.message)
                }
                setStateStale(true)
                return prev
              }
              return result.state as Record<string, unknown>
            })
            return

          case 'TEXT_MESSAGE_END':
            if (event.subagentRunId) return
            buffer.flushNow()
            // 流结束时把最后一句（可能没有句末标点）也播报掉
            announcerRef.current?.finish()
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

          // --- 生成式界面 ---
          //
          // 走 CUSTOM 事件：协议不可能为每种界面都定一个事件类型，
          // CUSTOM 就是给这类应用层扩展留的口子。
          case 'CUSTOM': {
            if (event.name !== 'ui.component' && event.name !== 'ui.declarative') return
            const id = `gen-${++genSeq.current}`
            setGenerated((prev) => ({
              ...prev,
              [id]:
                event.name === 'ui.component'
                  ? { kind: 'component', spec: event.value as ComponentSpec }
                  : { kind: 'declarative', tree: event.value as UiNode },
            }))
            setTimeline((prev) => [...prev, { kind: 'generated', id }])
            return
          }

          case 'RUN_ERROR':
            setErrorText(`${event.message}${event.code ? `（${event.code}）` : ''}`)
            setRunState('error')
            return

          case 'RUN_FINISHED': {
            const outcome = event.outcome
            // 中断式结束：这次运行**真的结束了**，只是结束方式是「等人做决定」。
            // 前端不是在等一个挂起的流，而是要发起下一次请求把决定带回去。
            if (outcome?.type === 'interrupt') {
              const payload = outcome.payload as { toolCallId?: string } | undefined
              const toolCallId = payload?.toolCallId ?? ''
              setPending({
                interruptId: outcome.interruptId,
                toolCallId,
                reason: outcome.reason,
                payload: outcome.payload,
              })
              setToolCalls((prev) => {
                const call = prev[toolCallId]
                return call
                  ? { ...prev, [toolCallId]: { ...call, status: 'awaiting-approval' } }
                  : prev
              })
            }
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
          body: JSON.stringify({ threadId: 'thread-demo', runId, resume, resumeFrom }),
          signal: controller.signal,
        })

        for await (const event of decodeEventStream(res)) {
          // 续播时服务端会重复发几条已收到的事件——重放边界不可能精确，
          // 所以去重是前端的责任。按标识和序号去重，绝不按内容。
          if (!trackerRef.current.accept(event)) continue
          if (isKnownEvent(event)) applyEvent(event)
        }

        buffer.flushNow()
        setRunState((prev) => (prev === 'running' ? 'idle' : prev))
      } catch (error) {
        // 用户主动打断不是错误，不要渲染成红色报错吓人
        if (error instanceof DOMException && error.name === 'AbortError') {
          setRunState('idle')
        } else {
          setErrorText(error instanceof Error ? error.message : String(error))
          setRunState('error')
        }
      } finally {
        buffer.dispose()
        abortRef.current = null
        const elapsedSec = Math.max((performance.now() - startedAt) / 1000, 0.001)
        setMeasurement((m) => ({
          ...m,
          updatesPerSecond: Math.round(updateCountRef.current / elapsedSec),
          domNodes: document.getElementsByTagName('*').length,
        }))
      }
    },
    [announcements, appendDeltas, inject]
  )

  /** 打断：abort 让界面立刻停，取消请求让服务端的账单也停下来。 */
  const stop = useCallback(async () => {
    const controller = abortRef.current
    if (!controller) return
    const result = await stopRun(controller, `run-${runIdRef.current}`)
    setStoppedNote(
      result.cancelRequested
        ? '已打断，并已通知服务端停止这次运行。'
        : '已打断前端连接，但取消请求没发出去——服务端可能还在跑。'
    )
  }, [])

  /** 续播：带上已收到的最大序号，服务端从那附近接着发。 */
  const resumeStream = useCallback(() => {
    setStoppedNote(null)
    void run(undefined, trackerRef.current.resumeFrom)
  }, [run])

  const send = useCallback(() => {
    const textToSend = draft.trim()
    if (!textToSend) return
    setDraft('')
    setStoppedNote(null)
    setSteps([])
    setSubagents({})
    trackerRef.current.reset()
    setTree((prev) => appendTurn(prev, textToSend))
    void run()
  }, [draft, run])

  /**
   * 编辑重发：从这一轮的**父节点**分叉，等于替换这一轮。
   * 旧分支完整保留，用户随时能切回去对比——这正是树相对线性历史的全部价值。
   */
  const resend = useCallback(
    (nodeId: string, newText: string) => {
      setEditing(null)
      setStoppedNote(null)
      setSteps([])
      setSubagents({})
      trackerRef.current.reset()
      setTree((prev) => editAndResend(prev, nodeId, newText))
      void run()
    },
    [run]
  )

  const decide = useCallback(
    (decision: ToolDecision) => {
      if (!pending) return
      setPending(null)
      // 决定不是本地生效，而是带进下一次请求让服务端执行。
      void run([
        {
          interruptId: pending.interruptId,
          status: decision.approve ? 'resolved' : 'cancelled',
          payload: pending.payload,
        },
      ])
    },
    [pending, run]
  )

  return (
    <div className="workbench">
      <div className="chat">
        <div className="toolbar">
          {runState === 'running' ? (
            <button type="button" onClick={stop}>
              停止
            </button>
          ) : (
            <button type="button" onClick={send} disabled={!draft.trim()}>
              发送
            </button>
          )}

          {stoppedNote ? (
            <button type="button" onClick={resumeStream}>
              续播
            </button>
          ) : null}

          <label>
            剧本
            <select value={inject} onChange={(e) => setInject(e.target.value)}>
              <option value="none">长任务 + 子 Agent</option>
              <option value="burst">生成式界面</option>
              <option value="unknown-component">未注册组件</option>
              <option value="cut">推理 + 共享状态</option>
              <option value="slow">补丁打不上</option>
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
              setReasonings({})
              setSharedState(null)
              setStateStale(false)
              setGenerated({})
              setTree(createTree())
              setSteps([])
              setSubagents({})
              setStoppedNote(null)
              trackerRef.current.reset()
              announcements.clear()
              announcerRef.current?.reset()
            }}
          >
            清空
          </button>
        </div>

        <input
          className="composer-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
          }}
          placeholder="说点什么，回车发送"
          aria-label="输入消息"
        />

        {/*
          实时区域：视觉上隐藏，只给屏幕阅读器。页面加载时必须是空的——
          带着内容出现的实时区域不会被播报。
        */}
        <LiveRegion message={announcements.current} />
        {errorText ? <LiveRegion message={`出错了：${errorText}`} urgent /> : null}

        {errorText ? <p className="error">出错了：{errorText}</p> : null}
        {stoppedNote ? <p className="stopped-note">{stoppedNote}</p> : null}

        <BudgetPanel measurement={measurement} />
        <RunProgress steps={steps} />
        <SubagentPanel agents={Object.values(subagents)} />

        {/* 会话树：只渲染从根到活动叶子的那条路径，每一轮带分支切换 */}
        {activePath(tree)
          .filter((node) => node.userText !== null)
          .map((node) => {
            const info = branchInfo(tree, node.id)
            return (
              <div className="turn" key={node.id}>
                <div className="turn-head">
                  <span>你</span>
                  <span className="branch-nav">
                    {info.total > 1 ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setTree(switchBranch(tree, info.siblings[info.index - 1]))}
                          disabled={info.index === 0}
                          aria-label="上一个分支"
                        >
                          ‹
                        </button>
                        <span data-testid="branch-indicator">
                          {info.index + 1} / {info.total}
                        </span>
                        <button
                          type="button"
                          onClick={() => setTree(switchBranch(tree, info.siblings[info.index + 1]))}
                          disabled={info.index === info.total - 1}
                          aria-label="下一个分支"
                        >
                          ›
                        </button>
                      </>
                    ) : null}
                    <button type="button" onClick={() => setEditing(node.id)}>
                      编辑
                    </button>
                  </span>
                </div>

                {editing === node.id ? (
                  <input
                    className="turn-edit"
                    defaultValue={node.userText ?? ''}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        resend(node.id, (e.target as HTMLInputElement).value)
                      }
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    aria-label="编辑这一轮并重发"
                  />
                ) : (
                  <p className="turn-text">{node.userText}</p>
                )}
              </div>
            )
          })}

        {/*
          aria-busy 让屏幕阅读器知道这块内容正在变化中，
          配合上面的分段播报，用户既不会被噪音淹没，也不会以为页面卡住了。
        */}
        <ol
          className="messages"
          ref={listRef}
          aria-busy={runState === 'running'}
          aria-label="对话内容"
        >
          {timeline.map((item) => {
            if (item.kind === 'message') {
              return messages[item.id] ? (
                <MessageItem key={`m-${item.id}`} message={messages[item.id]} />
              ) : null
            }
            if (item.kind === 'generated') {
              const g = generated[item.id]
              if (!g) return null
              return (
                <li key={`g-${item.id}`}>
                  {g.kind === 'component' ? (
                    <GenerativeBlock spec={g.spec} />
                  ) : (
                    <DeclarativeBlock tree={g.tree} />
                  )}
                </li>
              )
            }
            if (item.kind === 'reasoning') {
              return reasonings[item.id] ? (
                <li key={`r-${item.id}`}>
                  <ReasoningPanel reasoning={reasonings[item.id]} />
                </li>
              ) : null
            }
            return toolCalls[item.id] ? (
              <li key={`t-${item.id}`}>
                <ToolCallCard call={toolCalls[item.id]} onDecision={decide} />
              </li>
            ) : null
          })}
        </ol>

        {!pinned ? (
          <button type="button" className="jump" onClick={scrollToBottom}>
            回到底部
          </button>
        ) : null}

        {timeline.length === 0 ? <p className="hint">点「发送」开始。</p> : null}
      </div>

      <StateInspector state={sharedState} stale={stateStale} />
    </div>
  )
}
