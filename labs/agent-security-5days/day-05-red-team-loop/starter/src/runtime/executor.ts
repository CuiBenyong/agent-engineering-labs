import type { ModelAction } from '../core/mock-model.js'
import type { AuditEntry } from '../core/types.js'
import { evaluate, type TenantContext } from '../policy/engine.js'
import { redact } from '../policy/redact.js'

/** 人在回路：返回 true 表示这次人点了头。默认没人点头。 */
export type Approver = (action: ModelAction, reason: string) => boolean

export interface ExecutionReport {
  executed: ModelAction[]
  audit: AuditEntry[]
}

/**
 * 沙箱化的工具执行器。
 *
 * 它是策略层——你自己写的那一层。它管得住「这次调用允不允许发生」，
 * 管不住「已经发生的进程还能碰什么」。后者是隔离层（容器、虚拟机、
 * 内核级沙箱）的事，两层的失效方式完全不同，不要混为一谈。
 */
export function execute(
  actions: ModelAction[],
  ctx: TenantContext,
  approve: Approver = () => false
): ExecutionReport {
  const executed: ModelAction[] = []
  const audit: AuditEntry[] = []
  let seq = 0

  for (const action of actions) {
    const { decision, reason } = evaluate(action, ctx)
    let finalDecision = decision
    let finalReason = reason

    if (decision === 'confirm') {
      const approved = approve(action, reason)
      finalDecision = approved ? 'allow' : 'deny'
      finalReason = approved ? '人已确认：' + reason : '等待确认未获批准：' + reason
    }

    audit.push({
      seq: seq++,
      tool: action.tool,
      decision: finalDecision,
      reason: finalReason,
      // 记结构不记内容：参数进日志之前先过一遍脱敏。
      args: redact(`target=${action.target ?? '—'} because=${action.because}`),
    })

    if (finalDecision === 'allow') executed.push(action)
  }

  return { executed, audit }
}

export function renderAudit(audit: AuditEntry[]): string {
  const mark = { allow: '✅ 放行', confirm: '⏸ 待确认', deny: '⛔ 拒绝' }
  return audit
    .map(
      (e) => `#${e.seq} ${mark[e.decision]} ${e.tool}\n     理由：${e.reason}\n     参数：${e.args}`
    )
    .join('\n')
}
