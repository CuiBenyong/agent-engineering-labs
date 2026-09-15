import type { AuditEntry } from '../core/types.js'

/**
 * 行为基线与断路开关。
 *
 * 前四天做的都是「挡住一次坏动作」。这一层管的是另一件事：
 * **有人正在持续地试。**
 *
 * 基线用的是最笨也最难骗的口径：一次会话里被拒绝的动作数。
 * 正常使用几乎不会撞上出口白名单，撞一次是意外，连撞若干次就是有人在试。
 */
export interface BreakerState {
  tripped: boolean
  reason: string
}

export const DENY_BUDGET = 3

export function inspect(audit: AuditEntry[]): BreakerState {
  const denied = audit.filter((e) => e.decision === 'deny')
  if (denied.length > DENY_BUDGET) {
    return {
      tripped: true,
      reason: `一次会话里被拒动作 ${denied.length} 次，超过预算 ${DENY_BUDGET}`,
    }
  }

  // 同一个会话里反复换目标地址地试，是另一个很强的信号。
  const targets = new Set(denied.map((e) => e.args))
  if (targets.size > 2) {
    return { tripped: true, reason: `被拒动作换了 ${targets.size} 个不同目标` }
  }

  return { tripped: false, reason: '' }
}
