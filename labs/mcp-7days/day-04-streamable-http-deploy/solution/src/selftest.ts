// SELFTEST=1 的编排：起服务之后自己给自己发请求，逐项打印 ✅/❌ 并按结果设退出码。
// 这一份是验收入口，不是教学重点——先读 server.ts 与 tools.ts。
import {
  META_CLIENT_CAPS,
  META_CLIENT_INFO,
  META_VERSION,
  PROTOCOL_VERSION,
  encodeHeaderValue,
  type JsonValue,
} from './protocol.js'

const NAME_SOURCE: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

let nextId = 1

interface CallOptions {
  /** 故意破坏某个头，用来验证服务端的校验是不是真的生效了 */
  omitVersionHeader?: boolean
  wrongMethodHeader?: string
  origin?: string
}

function buildRequest(method: string, params: Record<string, JsonValue> = {}) {
  return {
    jsonrpc: '2.0' as const,
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: PROTOCOL_VERSION,
        [META_CLIENT_INFO]: { name: 'd4-selftest', version: '0.1.0' },
        // 声明支持表单式 elicitation，否则服务端不许给我们发 elicitation/create
        [META_CLIENT_CAPS]: { elicitation: { form: {} } },
        ...((params._meta as Record<string, JsonValue>) ?? {}),
      },
    },
  }
}

async function post(base: string, body: ReturnType<typeof buildRequest>, opts: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // 客户端必须同时声明两种都能收
    accept: 'application/json, text/event-stream',
    'mcp-method': opts.wrongMethodHeader ?? body.method,
  }
  if (!opts.omitVersionHeader) headers['mcp-protocol-version'] = PROTOCOL_VERSION
  if (opts.origin) headers.origin = opts.origin
  const nameField = NAME_SOURCE[body.method]
  if (nameField) {
    const value = (body.params as Record<string, JsonValue>)[nameField]
    if (typeof value === 'string') headers['mcp-name'] = encodeHeaderValue(value)
  }
  return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
}

/** 把一条 SSE 响应流读成事件数组。生产客户端还要处理半行拼接，这里够用。 */
async function readSse(res: Response): Promise<Record<string, JsonValue>[]> {
  const events: Record<string, JsonValue>[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (line.startsWith(':')) continue // 保活注释，忽略
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)))
      }
    }
  }
  return events
}

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${detail}`)
}

export async function runSelftest(base: string): Promise<number> {
  console.log(`\n=== D4 自测（${base}）===\n`)

  // 1. 普通工具调用回单个 JSON
  {
    const res = await post(
      base,
      buildRequest('tools/call', { name: 'echo_upper', arguments: { text: 'mcp' } })
    )
    const body = await res.json()
    const ok =
      res.headers.get('content-type')?.includes('application/json') === true &&
      body.result?.structuredContent?.upper === 'MCP'
    check(
      '普通 tools/call 回单个 JSON',
      ok,
      `content-type=${res.headers.get('content-type')} upper=${body.result?.structuredContent?.upper}`
    )
  }

  // 2. 慢工具回事件流，先进度后最终响应
  {
    const req = buildRequest('tools/call', {
      name: 'analyze_corpus',
      arguments: { documents: ['a b c', 'd e', 'f g h i'] },
      _meta: { progressToken: 'p-1' },
    })
    const res = await post(base, req)
    const isSse = res.headers.get('content-type')?.includes('text/event-stream') === true
    const events = isSse ? await readSse(res) : []
    const progress = events.filter((e) => e.method === 'notifications/progress')
    const final = events.find((e) => 'result' in e)
    const ok = isSse && progress.length >= 2 && !!final
    check(
      '慢工具走事件流且先发进度再发响应',
      ok,
      `sse=${isSse} 进度=${progress.length} 条 最终响应=${!!final}`
    )
    if (!isSse) await res.text()
  }

  // 3. 缺协议版本头
  {
    const res = await post(base, buildRequest('tools/list'), { omitVersionHeader: true })
    const body = await res.json()
    check(
      '缺 MCP-Protocol-Version 回 400',
      res.status === 400,
      `status=${res.status} code=${body.error?.code}`
    )
  }

  // 4. 头与体的方法名不一致
  {
    const res = await post(base, buildRequest('tools/list'), { wrongMethodHeader: 'tools/call' })
    const body = await res.json()
    const ok = res.status === 400 && body.error?.code === -32020
    check('头体方法名不一致回 400 与 -32020', ok, `status=${res.status} code=${body.error?.code}`)
  }

  // 5. 未实现的方法
  {
    const res = await post(base, buildRequest('resources/list'))
    const body = await res.json()
    const ok = res.status === 404 && body.error?.code === -32601
    check('未实现的方法回 404 与 -32601', ok, `status=${res.status} code=${body.error?.code}`)
  }

  // 6. 非法 Origin
  {
    const res = await post(base, buildRequest('tools/list'), { origin: 'https://evil.example.com' })
    await res.text()
    check('非法 Origin 回 403', res.status === 403, `status=${res.status}`)
  }

  // 7. MRTR：先拿 input_required，补齐输入用新 id 重试
  {
    const first = await post(
      base,
      buildRequest('tools/call', { name: 'book_meeting', arguments: { topic: '周会' } })
    )
    const firstBody = await first.json()
    const asked =
      firstBody.result?.resultType === 'input_required' &&
      !!firstBody.result?.inputRequests?.attendee_email

    const retry = await post(
      base,
      buildRequest('tools/call', {
        name: 'book_meeting',
        arguments: { topic: '周会' },
        inputResponses: {
          attendee_email: { action: 'accept', content: { email: 'a@example.com' } },
        },
        requestState: firstBody.result?.requestState,
      })
    )
    const retryBody = await retry.json()
    const done = retryBody.result?.resultType === 'complete' && retryBody.result?.isError !== true
    check(
      'MRTR 一轮走通（input_required 后带输入重试）',
      asked && done,
      `第一轮=${firstBody.result?.resultType} 第二轮=${retryBody.result?.structuredContent?.id ?? retryBody.result?.resultType}`
    )
  }

  // 8. 篡改过的 requestState 必须被拒。
  // 这里自己拼一个「结构完全合法、只有签名是假的」state，不依赖上一项是否已实现，
  // 否则练习 3 没做时这一项会因为解包失败而假绿。
  {
    const forgedPayload = Buffer.from(
      JSON.stringify({
        principal: 'user_demo',
        origin: 'tools/call:book_meeting',
        exp: Date.now() + 60_000,
        data: { topic: '攻击者塞进来的主题' },
      }),
      'utf8'
    ).toString('base64url')
    const tampered = `${forgedPayload}.${'x'.repeat(43)}`
    const res = await post(
      base,
      buildRequest('tools/call', {
        name: 'book_meeting',
        arguments: { topic: '周会' },
        inputResponses: {
          attendee_email: { action: 'accept', content: { email: 'a@example.com' } },
        },
        requestState: tampered,
      })
    )
    const body = await res.json()
    check(
      '被篡改的 requestState 被拒绝',
      body.result?.isError === true,
      `isError=${body.result?.isError}`
    )
  }

  const failed = results.filter((r) => !r.ok).length
  console.log(
    `\n共 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项。\n`
  )
  return failed === 0 ? 0 : 1
}
