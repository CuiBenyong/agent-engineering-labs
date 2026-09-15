'use client'

export type Subagent = {
  id: string
  name: string
  description?: string
  done: boolean
  text: string
}

/**
 * 子 Agent 区域。
 *
 * 归组靠 subagentRunId——和消息靠 messageId、工具靠 toolCallId 一样，
 * 流式协议里的归并一律靠标识不靠顺序。两个子 Agent 的事件是**交错到达**的，
 * 按顺序拼一定会串台。
 */
export function SubagentPanel({ agents }: { agents: Subagent[] }) {
  if (agents.length === 0) return null
  return (
    <div className="subagents" data-testid="subagents">
      {agents.map((a) => (
        <div key={a.id} className={`subagent${a.done ? ' done' : ''}`} data-testid="subagent">
          <div className="subagent-head">
            <strong>{a.name}</strong>
            <span>{a.done ? '完成' : '进行中'}</span>
          </div>
          {a.description ? <p className="subagent-desc">{a.description}</p> : null}
          <p className="subagent-text">{a.text}</p>
        </div>
      ))}
    </div>
  )
}
