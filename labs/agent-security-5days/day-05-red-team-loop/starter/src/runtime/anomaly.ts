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
  // TODO(2)：两条基线，命中任意一条就跳闸。
  //   1. 一次会话里被拒动作数超过 DENY_BUDGET
  //   2. 被拒动作的目标地址超过 2 个不同值（有人在换着门试）
  // 挑这两条是因为它们最难骗：正常使用几乎不会撞上出口白名单。
  void audit
  void DENY_BUDGET
  return { tripped: false, reason: '' }
}
