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
    // TODO(5)：跑一次 evaluate()；decision 为 confirm 时问一次 approve()，
    // 点头才变 allow，没点头变 deny。每一次裁决都要写进 audit，
    // **包括被拒的那些**——事故复盘要看的恰恰是被拒的那几条。
    // 参数进日志之前先过一遍 redact()：记结构，不记内容。
    void action
    void evaluate
    void approve
    void redact
    void seq
    void audit
    void executed
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
