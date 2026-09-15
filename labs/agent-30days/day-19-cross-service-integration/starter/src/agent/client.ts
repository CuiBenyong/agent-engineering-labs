/**
 * 调用方发出去的三类请求。注意每个方法都不传 userId——身份在 Authorization 头里，
 * 不在请求体里。这条不变量和 D12 的 memory_search 不给模型身份参数是同一条。
 */
export interface CallResult {
  status: number
  body: Record<string, unknown>
}

async function call(
  baseUrl: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<CallResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const parsed: unknown = text ? JSON.parse(text) : {}
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> }
}

export function createKodaClient(baseUrl: string, token: string) {
  return {
    /** 注入一条外部事件。externalId 由调用方生成，必须能从事件本身推出来。 */
    inject: (externalId: string, text: string, extra: Record<string, unknown> = {}) =>
      call(baseUrl, token, 'POST', '/v1/inject', { externalId, text, ...extra }),
    writeMemory: (content: string, extra: Record<string, unknown> = {}) =>
      call(baseUrl, token, 'POST', '/v1/memory', { content, ...extra }),
    listMemory: () => call(baseUrl, token, 'GET', '/v1/memory'),
    usage: () => call(baseUrl, token, 'GET', '/v1/usage'),
  }
}

export type KodaClient = ReturnType<typeof createKodaClient>
