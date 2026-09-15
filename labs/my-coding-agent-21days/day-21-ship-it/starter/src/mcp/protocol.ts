/**
 * MCP 协议这一层的常量、类型与两个纯函数。本天新增。
 *
 * 口径：本课按 **2026-07-28** 这一版规范写。它与网上大量教程的差别大到会把人绕进去，
 * 最要紧的三条：
 *   1. **无状态**：没有 initialize 握手，也没有 notifications/initialized。
 *      版本、身份、能力写在**每一条请求**的 _meta 里，每次都重复一遍。
 *   2. **服务端不再向客户端发起 JSON-RPC 请求**。它需要客户端配合时，
 *      把需求塞进**结果**里返回（resultType 为 input_required），客户端补齐后换一个
 *      新 id 重发原请求。本课的客户端不实现这一支，但必须认得它，见 isInputRequired。
 *   3. **传输只剩两种**：stdio 与 Streamable HTTP。
 *
 * 不在下面这些字段表里的东西，一律以官方规范为准，不要照别家格式猜。
 */

export const PROTOCOL_VERSION = '2026-07-28'

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities'

export const CLIENT_INFO = { name: 'mca', version: '0.15.0' }

/**
 * 我们这个客户端不弹表单、也不把模型借给服务端用，所以能力表老实声明成空对象。
 * 声明得越诚实，服务端越早发现「这件事你干不了」——规范也要求服务端
 * 不得依赖客户端没有声明过的能力。
 */
export const CLIENT_CAPABILITIES: Record<string, unknown> = {}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

/** 一条 JSON-RPC 消息。响应与通知共用这个形状：有 id 的是响应，没有的是通知 */
export interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, JsonValue>
  result?: Record<string, JsonValue>
  error?: { code?: number; message?: string; data?: JsonValue }
}

export interface McpToolDef {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, JsonValue>
  outputSchema?: Record<string, JsonValue>
  /** 服务端的自我声明，**不可信**，见 mount.ts 里那段注释 */
  annotations?: Record<string, JsonValue>
}

export interface ToolCallResult {
  resultType?: string
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, JsonValue>
  isError?: boolean
}

/**
 * 每条请求都要带的 _meta。无状态协议下这不是握手，是每次都得重说一遍的自我介绍。
 *
 * 注意它是**加在 params 上**的，不是加在顶层。写错这一处的表现是服务端回 -32021
 * 说「你没声明能力」，而你明明写了——写在了它不看的地方。
 */
export function withMeta(params: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    ...params,
    _meta: {
      [META_VERSION]: PROTOCOL_VERSION,
      [META_CLIENT_INFO]: CLIENT_INFO,
      [META_CLIENT_CAPS]: CLIENT_CAPABILITIES as JsonValue,
    },
  }
}

/** 服务端要客户端补东西才能继续。本课不实现，但要能认出来并如实告诉模型 */
export function isInputRequired(result: ToolCallResult): boolean {
  return result.resultType === 'input_required'
}

/**
 * 把工具结果里的文本拼成一段给模型看的字符串。
 *
 * 两条口径：**只取 text 类型的块**（图片等二进制块不该直接塞进文本上下文）；
 * 一个文本块都没有时退到 structuredContent 的 JSON，再没有就明说「没有内容」——
 * 绝不要返回空字符串，模型看到空串会以为是自己参数写错了，然后原样重试一次。
 */
export function resultText(result: ToolCallResult): string {
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
  if (text) return text
  if (result.structuredContent) return JSON.stringify(result.structuredContent)
  return '（这个工具没有返回任何内容）'
}

/** 协议层面的错误：版本不支持、方法不存在、参数结构不合法。它不是「工具失败」 */
export class McpError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'McpError'
    this.code = code
  }
}
