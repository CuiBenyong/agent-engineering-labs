// 2026-07-28 的协议常量与类型。这一版没有握手：版本、身份、能力都在每条请求的 _meta 里。
export const PROTOCOL_VERSION = '2026-07-28'

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities'

export const CLIENT_INFO = { name: 'd5-mini-client', version: '0.1.0' }

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// 我们这个客户端不实现 elicitation，也不借出模型，所以老实声明成空对象。
// 声明得越诚实，服务端越早发现「这事你干不了」，而不是等到运行时。
export const CLIENT_CAPABILITIES: JsonValue = {}

export interface McpToolDef {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, JsonValue>
  outputSchema?: Record<string, JsonValue>
  annotations?: Record<string, JsonValue>
}

export interface ToolCallResult {
  resultType?: string
  content?: { type: string; text?: string }[]
  structuredContent?: Record<string, JsonValue>
  isError?: boolean
}

/** 每条请求都要带的 _meta。无状态协议下这不是握手，是每次都得重复一遍的自我介绍。 */
export function withMeta(params: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    ...params,
    _meta: {
      [META_VERSION]: PROTOCOL_VERSION,
      [META_CLIENT_INFO]: CLIENT_INFO,
      [META_CLIENT_CAPS]: CLIENT_CAPABILITIES,
    },
  }
}

/** 把工具结果里的文本拼成一段给模型看的字符串。 */
export function resultText(result: ToolCallResult): string {
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
  if (text) return text
  if (result.structuredContent) return JSON.stringify(result.structuredContent)
  return '(工具没有返回任何内容)'
}
