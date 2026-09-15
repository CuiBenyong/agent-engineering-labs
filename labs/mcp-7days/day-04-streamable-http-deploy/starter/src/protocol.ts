// 2026-07-28 协议里跟传输相关的那部分常量与小工具。
// 这一份是手写的，不依赖任何 MCP SDK——理由见 README「为什么不用官方 SDK」。
import crypto from 'node:crypto'

export const PROTOCOL_VERSION = '2026-07-28'
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION]
export const SERVER_INFO = { name: 'd4-remote-mcp', version: '0.1.0' }

/** 规范把 -32020 到 -32099 划给 MCP 自己用；-32000 到 -32019 是历史遗留，新代码不许再占。 */
export const ERR = {
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

export type JsonValue = unknown

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, JsonValue>
}

export interface RpcError {
  code: number
  message: string
  data?: JsonValue
}

/** 带上服务端身份的成功结果。resultType 是这一版新增的必填字段。 */
export function completeResult(body: Record<string, JsonValue>): Record<string, JsonValue> {
  return { resultType: 'complete', ...body, _meta: { [META_SERVER_INFO]: SERVER_INFO } }
}

export function inputRequiredResult(body: Record<string, JsonValue>): Record<string, JsonValue> {
  return { resultType: 'input_required', ...body, _meta: { [META_SERVER_INFO]: SERVER_INFO } }
}

export function rpcOk(id: string | number, result: Record<string, JsonValue>) {
  return { jsonrpc: '2.0' as const, id, result }
}

export function rpcErr(id: string | number | null, error: RpcError) {
  return { jsonrpc: '2.0' as const, ...(id === null ? {} : { id }), error }
}

/**
 * 请求头里的值可能被 Base64 哨兵格式包起来（非 ASCII、含控制字符、首尾空白时必须这么做）。
 * 服务端在和请求体比对之前必须先解码，否则一个中文工具名就会被误判成头体不一致。
 */
export function decodeHeaderValue(raw: string): string {
  if (raw.startsWith('=?base64?') && raw.endsWith('?=')) {
    return Buffer.from(raw.slice('=?base64?'.length, -'?='.length), 'base64').toString('utf8')
  }
  return raw
}

/** 客户端侧的对偶：不能安全表示成 ASCII 头值时才编码。 */
export function encodeHeaderValue(value: string): string {
  const safe = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value)
  if (safe && !(value.startsWith('=?base64?') && value.endsWith('?='))) return value
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

const STATE_SECRET = process.env.REQUEST_STATE_SECRET ?? 'dev-only-secret-change-me'

export interface RequestStatePayload {
  /** 认证主体。换一个人拿着同一个 state 来，必须被拒。 */
  principal: string
  /** 原始请求的标识，防止把 A 工具的 state 拿去 B 工具用。 */
  origin: string
  /** 短过期，缩小重放窗口。 */
  exp: number
  data: Record<string, JsonValue>
}

/**
 * requestState 会经客户端的手转一圈再回来，规范把它定义为「攻击者可控输入」。
 * 只要它会影响授权、资源访问或业务逻辑，服务端就必须做完整性保护并拒绝校验失败的值。
 */
export function signRequestState(payload: RequestStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = crypto.createHmac('sha256', STATE_SECRET).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyRequestState(
  state: string,
  expect: { principal: string; origin: string }
): RequestStatePayload | null {
  const [body, mac] = state.split('.')
  if (!body || !mac) return null

  // 练习 4：把 requestState 真正验一遍。现在的实现只解了个包就信了，
  // 等于把「攻击者可控输入」直接当成服务端状态用——自测第 8 项会因此变红。
  // 要做四件事：
  //   1) 用 STATE_SECRET 重算 HMAC，并用 crypto.timingSafeEqual 定长比较（长度不等直接判失败）
  //   2) 校验 payload.principal 等于 expect.principal（挡跨用户重放）
  //   3) 校验 payload.origin 等于 expect.origin（挡把 A 工具的 state 拿去 B 工具用）
  //   4) 校验 payload.exp 还没过期
  // 提示：crypto 已经 import 好了，签名那一半在上面的 signRequestState 里。
  void expect
  void crypto
  let payload: RequestStatePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  return payload
}
