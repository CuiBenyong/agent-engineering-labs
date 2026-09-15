/**
 * 权限信封（ToolPolicy）——本实验的地基。
 *
 * 它由**服务端会话的 scope** 决定，绝不由模型决定，也绝不从对话内容里读。
 * 三条防线里，输入检测与输出过滤都是概率性的，只有这一层是确定性的：
 * 模型无论被说服成什么样，都调不到白名单外的工具、超不过参数上限。
 *
 * 类型形状与正文一致，跨天引用时照抄这一份。
 */
export interface ToolPolicy {
  /** 白名单：执行前判，不在其中直接拒绝 */
  allowedTools: string[]
  /** 参数级上限，键是工具名（沿用 D5 的 apply_refund 金额闸） */
  paramLimits: Record<string, ParamLimit>
  /** 不可逆工具，沿用 D5 的三档划分：模型只能提议，人点头才执行 */
  requireApproval: string[]
}

export interface ParamLimit {
  field: string
  /** 数值上限。对可批准的工具是「自动执行上限」，对其余工具是硬上限 */
  max?: number
  allowedValues?: string[]
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export type PolicyDecision =
  { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'approval'; reason: string }

/** 完整会话：客服可以退小额款，大额转人工。 */
export const AGENT_POLICY: ToolPolicy = {
  allowedTools: ['query_order', 'track_shipment', 'query_refund', 'apply_refund', 'memory_search'],
  paramLimits: {
    // 沿用 D5：50 元以内自动执行，超过必须人工点头。不要改这个数。
    apply_refund: { field: 'amount', max: 50 },
    memory_search: { field: 'topK', max: 5 },
  },
  requireApproval: ['apply_refund'],
}

/** 只读会话：同一份业务代码，换一个信封就少一半能力。 */
export const READONLY_POLICY: ToolPolicy = {
  allowedTools: ['query_order', 'track_shipment', 'query_refund'],
  paramLimits: {},
  requireApproval: [],
}

/**
 * 唯一的闸门。执行任何工具之前必须先过它，没有第二个入口。
 *
 * 判定顺序是有讲究的：先白名单（最便宜、最确定），再参数，最后才是人工确认——
 * 反过来写的话，一个不在白名单里的工具名会先被拿去查参数表，查不到就放行了。
 */
export function enforceToolPolicy(policy: ToolPolicy, call: ToolCall): PolicyDecision {
  // 第一道：白名单。模型凭空编出来的工具名也在这里被挡掉。
  if (!policy.allowedTools.includes(call.name)) {
    return { kind: 'deny', reason: `工具 ${call.name} 不在本次会话的白名单里` }
  }

  const needsApproval = policy.requireApproval.includes(call.name)
  const limit = policy.paramLimits[call.name]
  // 「参数在自动执行上限之内」——只有它能让一个不可逆工具免掉人工确认
  let underCap = false

  if (limit) {
    const value = call.args[limit.field]

    if (limit.allowedValues) {
      if (typeof value !== 'string' || !limit.allowedValues.includes(value)) {
        return {
          kind: 'deny',
          reason: `${call.name}.${limit.field} 只允许取 ${limit.allowedValues.join(' / ')}`,
        }
      }
    }

    if (limit.max !== undefined) {
      // 缺参数、参数不是数字，一律按拒绝处理：默认拒绝而不是默认放行
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { kind: 'deny', reason: `${call.name}.${limit.field} 缺失或不是数字` }
      }
      if (value > limit.max) {
        // 可批准的工具超上限 → 转人工；不可批准的工具超上限 → 直接拒绝（没有人工兜底）
        const reason = `${call.name}.${limit.field}=${value} 超过上限 ${limit.max}`
        return needsApproval ? { kind: 'approval', reason } : { kind: 'deny', reason }
      }
      underCap = true
    }
  }

  if (needsApproval && !underCap) {
    return { kind: 'approval', reason: `${call.name} 是不可逆操作，必须人工确认` }
  }
  return { kind: 'allow' }
}
