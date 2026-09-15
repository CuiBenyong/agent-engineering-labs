// 协议常量与两个响应构造器。2026-07-28 的成功结果一律带 resultType。
export const PROTOCOL_VERSION = '2026-07-28'

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface McpToolDef {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, JsonValue>
  outputSchema?: Record<string, JsonValue>
  annotations?: Record<string, JsonValue>
}

export const SERVER_INFO = { name: 'docs', version: '1.0.0' }

export function ok(id: number, result: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      ...result,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    },
  }
}

export function fail(id: number, code: number, message: string): Record<string, JsonValue> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
