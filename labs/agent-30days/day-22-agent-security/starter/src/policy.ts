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
 * 练习 1 与练习 2 都在这个函数里。挖空版现在等于「除了不可逆工具要人点头之外一律放行」——
 * 跑一次自检你会看到第 4、5、8 项是 ❌，那就是「闸门还没装上」的样子。
 */
export function enforceToolPolicy(policy: ToolPolicy, call: ToolCall): PolicyDecision {
  // 练习 1：白名单。call.name 不在 policy.allowedTools 里就返回
  //   { kind: 'deny', reason: ... }。
  //   提示：这一步必须放在最前面。放到参数检查之后的话，一个模型凭空编出来的工具名
  //   会因为在 paramLimits 里查不到而被一路放行。

  const needsApproval = policy.requireApproval.includes(call.name)

  // 练习 2：参数级上限。取 policy.paramLimits[call.name]，按四种情况判：
  //   - 配了 allowedValues 而实际取值不在其中 → deny
  //   - 配了 max 但参数缺失或不是数字 → deny（默认拒绝，不是默认放行）
  //   - 超过 max → 可批准的工具转 approval，其余工具直接 deny（它们没有人工兜底）
  //   - 在 max 之内 → 这一次可以免掉人工确认（沿用 D5：50 元以内的退款自动执行）
  void policy.paramLimits

  if (needsApproval) {
    return { kind: 'approval', reason: `${call.name} 是不可逆操作，必须人工确认` }
  }
  return { kind: 'allow' }
}
