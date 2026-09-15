/**
 * 两个服务共享的形状。本天只新增 external_events 一张表，
 * sessions / messages 来自 D8、memories 来自 D12、usage_ledger 来自 D13，字段一律照抄，本天不改。
 */

/** JWT 里唯一的授权信息。scope 之外不放任何业务数据——JWT 是 base64，不是加密。 */
export const SCOPES = ['inject:write', 'memory:read', 'memory:write', 'usage:read'] as const
export type Scope = (typeof SCOPES)[number]

/**
 * 验签通过之后解出来的调用者身份。
 * 安全不变量：这个结构只能由 token 填充，请求体里的任何 userId 都不许进来。
 */
export interface Caller {
  userId: string // JWT 的 sub
  issuer: string // iss
  scopes: Scope[] // scope 字符串按空格拆开
  jti: string // 这一张 token 的编号，用于审计
}

/** D19 新增：external_events(external_id unique, kind, payload, created_at)。 */
export interface ExternalEventRow {
  externalId: string
  kind: string
  payload: string
  createdAt: string
}

/** messages（D8），本天不改。 */
export interface MessageRow {
  id: string
  sessionId: string
  runId: string | null
  role: string
  content: string
  seq: number
}

/** memories（D12）。本 lab 不引入 embedding 依赖，所以省掉了 embedding 列，其余字段照抄。 */
export interface MemoryRow {
  id: string
  userId: string
  sourceRunId: string | null
  content: string
  createdAt: string
}

/** usage_ledger（D13），本天不改。金额一律用微美元整数，理由见 D13。 */
export interface UsageRow {
  id: string
  userId: string
  runId: string | null
  model: string
  kind: 'chat' | 'embedding'
  promptTokens: number
  completionTokens: number
  costMicroUsd: number
  createdAt: string
}

export interface UsageSummary {
  calls: number
  promptTokens: number
  completionTokens: number
  costMicroUsd: number
}

export function parseScopes(raw: unknown): Scope[] {
  if (typeof raw !== 'string') return []
  const known = new Set<string>(SCOPES)
  return raw.split(' ').filter((s): s is Scope => known.has(s))
}

export function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(6)}`
}
