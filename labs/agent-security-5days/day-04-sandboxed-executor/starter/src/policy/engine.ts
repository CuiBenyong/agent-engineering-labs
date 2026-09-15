import type { ModelAction } from '../core/mock-model.js'
import type { PolicyDecision } from '../core/types.js'
import { lookup, riskTier } from './capabilities.js'
import { checkEmail, checkUrl } from './egress.js'

export interface TenantContext {
  tenantId: string
  userId: string
  /** 这次运行允许触达的租户。**只来自会话，不来自模型的输出。** */
  allowedTenants: string[]
}

export interface PolicyResult {
  decision: PolicyDecision
  reason: string
}

/**
 * 策略引擎：一次工具调用能不能做，在这里一次判完。
 *
 * 三条顺序不能换：
 *   1. 工具认不认识——认不出的一律拒绝，默认拒绝才是白名单。
 *   2. 出口能不能到——先判目的地，再判要不要人来点头。
 *      顺序反过来会让人去为一个本来就该拒的动作点头，这是在训练人麻木。
 *   3. 危险等级要不要人点头——不可逆的对外动作必须过确认门。
 *
 * 确认门必须放在这里（服务端的工具执行器），不能放在前端：
 * 前端拦不住已经在服务端跑起来的运行，也拦不住改过的请求。
 */
export function evaluate(action: ModelAction, ctx: TenantContext): PolicyResult {
  // TODO(4)：按注释里的三条顺序判完。顺序不能换，理由写在上面。
  //   1. lookup() 认不出的工具直接 deny
  //   2. effect 为 send 时先过出口白名单（http 开头走 checkUrl，否则 checkEmail）
  //   3. 触达 private 数据时，ctx.tenantId 必须在 ctx.allowedTenants 里
  //   4. riskTier 为 dangerous 时返回 confirm，其余 allow
  void action
  void ctx
  void lookup
  void riskTier
  void checkUrl
  void checkEmail
  return { decision: 'allow', reason: '' }
}
