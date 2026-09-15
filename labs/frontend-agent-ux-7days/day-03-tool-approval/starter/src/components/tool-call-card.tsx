'use client'

import { describeArgs, looksDestructive, type ToolCall } from '@/stream/tool-calls'

const STATUS_LABEL: Record<ToolCall['status'], string> = {
  preparing: '准备参数',
  running: '执行中',
  'awaiting-approval': '等待你确认',
  success: '完成',
  error: '失败',
  rejected: '已拒绝',
}

export type ToolDecision = { approve: boolean }

export function ToolCallCard({
  call,
  onDecision,
}: {
  call: ToolCall
  onDecision?: (decision: ToolDecision) => void
}) {
  const needsApproval = call.status === 'awaiting-approval'
  const dangerous = looksDestructive(call.name)

  return (
    <div
      className={`tool-card status-${call.status}${dangerous ? ' dangerous' : ''}`}
      data-testid="tool-card"
    >
      <div className="tool-head">
        <code className="tool-name">{call.name}</code>
        <span className="tool-status" data-testid="tool-status">
          {STATUS_LABEL[call.status]}
        </span>
      </div>

      <p className="tool-args" data-testid="tool-args">
        {describeArgs(call)}
      </p>

      {needsApproval ? (
        <div className="tool-approval">
          {/* 危险操作不做默认选择，也不把「同意」设成焦点默认项：
              审批界面的默认值等于替用户做了决定。 */}
          <p className="tool-warn">这个操作不可撤销，请确认后再继续。</p>
          <div className="tool-actions">
            <button type="button" onClick={() => onDecision?.({ approve: true })}>
              同意执行
            </button>
            <button type="button" onClick={() => onDecision?.({ approve: false })}>
              拒绝
            </button>
          </div>
        </div>
      ) : null}

      {call.result && !needsApproval ? (
        <pre className="tool-result" data-testid="tool-result">
          {call.result}
        </pre>
      ) : null}
    </div>
  )
}
