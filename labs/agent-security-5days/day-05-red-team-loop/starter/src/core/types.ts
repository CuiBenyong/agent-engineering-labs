// ── 冻结文件（agent-security-5days 全课公共类型）────────────────────────────
// D1 定稿，D2–D5 逐字复制。改动后必须跑 bash scripts/check-agsec-consistency.sh。
// 逐字复制的理由：五天的靶场、策略引擎、红队脚本共用同一套契约，
// 任何一天悄悄改字段名，前面几天的副本就会变成过期内容。

/** 一段内容的可信度标签。unrusted 的内容里出现的任何祈使句都不算指令。 */
export type TrustLabel = 'trusted' | 'untrusted'

/** 工具触达的数据敏感度。 */
export type DataSensitivity = 'public' | 'internal' | 'private'

/** 工具的主要作用：读取、写入、对外发送。 */
export type ToolEffect = 'read' | 'write' | 'send'

export interface ToolSpec {
  name: string
  description: string
  /** 主要作用 */
  effect: ToolEffect
  /** 这个工具的返回内容是不是不可信输入 */
  returnsUntrusted: boolean
  /** 它能触达的数据敏感度 */
  sensitivity: DataSensitivity
  /** 动作可不可逆：不可逆的动作出错就没有第二次机会 */
  reversible: boolean
}

export interface AgentConfig {
  id: string
  description: string
  /** 用户输入本身可不可信：面向公网的 Agent 是 untrusted */
  userInputTrust: TrustLabel
  tools: ToolSpec[]
}

export type Severity = 'critical' | 'high' | 'medium' | 'low'

/** 一条风险条目：能逐条打勾的最小单位。 */
export interface RiskItem {
  id: string
  title: string
  severity: Severity
  /** 对应的 OWASP 编号，可能同时落在两张清单上 */
  owasp: string[]
  /** 证据：是配置里的哪几个工具让这条风险成立的 */
  evidence: string[]
  mitigation: string
}

/** 致命三件套的判定结果。 */
export interface TrifectaVerdict {
  privateData: string[]
  untrustedContent: string[]
  externalComms: string[]
  /** 三条同时成立才是 complete */
  complete: boolean
}

// ── 以下类型 D4 起用到，放在这里是为了只冻结一次 ───────────────────────────

/** 策略引擎对一次工具调用的裁决。 */
export type PolicyDecision = 'allow' | 'confirm' | 'deny'

export interface AuditEntry {
  seq: number
  tool: string
  decision: PolicyDecision
  /** 裁决理由，必须能在事故复盘时读懂 */
  reason: string
  /** 已脱敏的参数摘要 */
  args: string
}
