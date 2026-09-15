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
  const spec = lookup(action.tool)
  if (!spec) return { decision: 'deny', reason: `未登记的工具：${action.tool}` }

  if (spec.effect === 'send') {
    const target = action.target ?? ''
    const verdict = target.startsWith('http') ? checkUrl(target) : checkEmail(target)
    if (!verdict.allowed) return { decision: 'deny', reason: verdict.reason }
  }

  if (spec.sensitivity === 'private' && !ctx.allowedTenants.includes(ctx.tenantId)) {
    return { decision: 'deny', reason: `租户 ${ctx.tenantId} 不在本次会话的可访问范围内` }
  }

  const tier = riskTier(spec)
  if (tier === 'dangerous') {
    return { decision: 'confirm', reason: '不可逆的对外动作，需要人确认' }
  }
  return { decision: 'allow', reason: `危险等级 ${tier}` }
}
