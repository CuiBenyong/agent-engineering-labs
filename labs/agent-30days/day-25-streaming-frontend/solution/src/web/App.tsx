/**
 * React 组件层。这里只有渲染和事件绑定——流式状态全在 store.ts 里，
 * 所以换成 Vue、SwiftUI 或者 Compose，要重写的只有这个文件。
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { ToolCard } from '../stream/reduce'
import { type ChatStore, createChatStore } from './store'

const box: React.CSSProperties = {
  maxWidth: 720,
  margin: '0 auto',
  padding: 24,
  fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
  lineHeight: 1.7,
}

function ToolCardView({ card }: { card: ToolCard }): React.ReactElement {
  const label: Record<ToolCard['status'], string> = {
    proposed: '准备调用',
    running: '正在查询订单…',
    done: '查询完成',
    error: '调用失败',
  }
  return (
    <div
      style={{
        border: '1px solid #d5d9e0',
        borderRadius: 8,
        padding: '10px 12px',
        margin: '8px 0',
        background: '#f7f8fa',
        fontSize: 14,
      }}
    >
      <div style={{ fontWeight: 600 }}>
        🔧 {card.name} · {label[card.status]}
        {card.ms !== undefined ? ` · ${card.ms}ms` : ''}
      </div>
      <div style={{ color: '#5a6472', wordBreak: 'break-all' }}>
        参数：{JSON.stringify(card.args)}
      </div>
      {card.approvalRequired && card.status === 'proposed' ? (
        <div style={{ color: '#b26a00' }}>等待人工确认（不可逆工具）</div>
      ) : null}
      {card.result ? (
        <div style={{ color: '#5a6472', wordBreak: 'break-all' }}>结果：{card.result}</div>
      ) : null}
      {card.error ? <div style={{ color: '#c0392b' }}>错误：{card.error}</div> : null}
    </div>
  )
}

export function App({ store }: { store?: ChatStore } = {}): React.ReactElement {
  const chat = useMemo(() => store ?? createChatStore(''), [store])
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot)
  const [draft, setDraft] = useState('我的订单 A1002 到哪了')

  return (
    <div style={box}>
      <h1 style={{ fontSize: 20 }}>mini-koda · 流式聊天</h1>
      <p style={{ color: '#5a6472', fontSize: 14 }}>
        本轮渲染提交次数：{state.flushCount}（对比一下服务端吐了多少个 token）
      </p>

      {state.items.map((item) =>
        item.kind === 'user' ? (
          <p key={item.id} style={{ textAlign: 'right' }}>
            <span style={{ background: '#e8f0fe', borderRadius: 8, padding: '6px 10px' }}>
              {item.text}
            </span>
          </p>
        ) : (
          <div key={item.id}>
            {item.turn.tools.map((card) => (
              <ToolCardView key={card.callId} card={card} />
            ))}
            <p style={{ whiteSpace: 'pre-wrap' }}>
              {item.turn.text}
              {item.turn.status === 'streaming' ? <span>▋</span> : null}
            </p>
            {item.turn.status === 'cancelled' ? (
              <p style={{ color: '#b26a00' }}>（已打断）</p>
            ) : null}
            {item.turn.status === 'error' ? (
              <p style={{ color: '#c0392b' }}>（出错：{item.turn.error}）</p>
            ) : null}
          </div>
        )
      )}

      {state.error ? <p style={{ color: '#c0392b' }}>请求失败：{state.error}</p> : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input
          style={{ flex: 1, padding: 8 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') chat.send(draft)
          }}
        />
        <button onClick={() => chat.send(draft)} disabled={state.busy}>
          发送
        </button>
        <button onClick={() => chat.stop()} disabled={!state.busy}>
          打断
        </button>
        <button onClick={() => chat.retry()} disabled={!state.canRetry}>
          重试
        </button>
      </div>
    </div>
  )
}
