// Streamable HTTP 绑定：单个 POST 端点，两种响应形态，一套必填请求头。
import http from 'node:http'
import {
  ERR,
  META_CLIENT_CAPS,
  META_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  SERVER_INFO,
  completeResult,
  decodeHeaderValue,
  rpcErr,
  rpcOk,
  type JsonRpcRequest,
  type JsonValue,
  type RpcError,
} from './protocol.js'
import { TOOL_BY_NAME, listTools, type ToolContext } from './tools.js'

const MCP_PATH = '/mcp'
/** 本机开发时的合法来源。规范要求 Origin 存在且非法时必须回 403，防 DNS 重绑定。 */
const ALLOWED_ORIGINS = new Set(['http://localhost', 'http://127.0.0.1', 'null'])

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true // 没有 Origin 头的（比如 curl、服务端到服务端）不受这条限制
  try {
    const u = new URL(origin)
    return ALLOWED_ORIGINS.has(`${u.protocol}//${u.hostname}`) || ALLOWED_ORIGINS.has(origin)
  } catch {
    return false
  }
}

/** 需要 Mcp-Name 头的三个方法，以及各自从请求体的哪个字段取值。 */
const NAME_SOURCE: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

/**
 * 练习 1 的落点：请求头与请求体的一致性校验。
 * 这一步的意义是防止「负载均衡按头路由、服务端按体执行」造成的不一致漏洞。
 * 返回 null 表示通过，否则返回要回给客户端的错误。
 */
export function checkHeaders(
  headers: http.IncomingHttpHeaders,
  msg: JsonRpcRequest
): RpcError | null {
  const version = headers['mcp-protocol-version']
  if (typeof version !== 'string') {
    return { code: ERR.HEADER_MISMATCH, message: '缺少必填请求头 MCP-Protocol-Version' }
  }
  const bodyVersion = (msg.params?._meta as Record<string, JsonValue> | undefined)?.[META_VERSION]
  if (version !== bodyVersion) {
    return {
      code: ERR.HEADER_MISMATCH,
      message: `MCP-Protocol-Version 头（${version}）与请求体（${String(bodyVersion)}）不一致`,
    }
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return {
      code: ERR.UNSUPPORTED_PROTOCOL_VERSION,
      message: `不支持的协议版本 ${version}`,
      data: { supported: SUPPORTED_VERSIONS },
    }
  }

  const method = headers['mcp-method']
  if (typeof method !== 'string') {
    return { code: ERR.HEADER_MISMATCH, message: '缺少必填请求头 Mcp-Method' }
  }
  if (method !== msg.method) {
    return {
      code: ERR.HEADER_MISMATCH,
      message: `Mcp-Method 头（${method}）与请求体 method（${msg.method}）不一致`,
    }
  }

  const nameField = NAME_SOURCE[msg.method]
  if (nameField) {
    const raw = headers['mcp-name']
    if (typeof raw !== 'string') {
      return { code: ERR.HEADER_MISMATCH, message: `${msg.method} 缺少必填请求头 Mcp-Name` }
    }
    // 先解码再比对，否则一个中文工具名就会被误判成不一致
    if (decodeHeaderValue(raw) !== msg.params?.[nameField]) {
      return { code: ERR.HEADER_MISMATCH, message: 'Mcp-Name 头与请求体不一致' }
    }
  }
  return null
}

/** 协议无状态：每条请求都要自带版本与能力，服务端不许靠上一条请求记住。 */
function checkMeta(msg: JsonRpcRequest): RpcError | null {
  const meta = msg.params?._meta as Record<string, JsonValue> | undefined
  if (!meta || meta[META_VERSION] === undefined) {
    return { code: ERR.INVALID_PARAMS, message: `缺少 ${META_VERSION}` }
  }
  if (meta[META_CLIENT_CAPS] === undefined) {
    return { code: ERR.INVALID_PARAMS, message: `缺少 ${META_CLIENT_CAPS}` }
  }
  return null
}

interface Handled {
  /** 直接可回的结果；开事件流的工具走 stream 分支。 */
  result?: Record<string, JsonValue>
  error?: RpcError
  /** 404 语义：方法不存在。 */
  notFound?: boolean
  stream?: (progress: ToolContext['progress']) => Promise<Record<string, JsonValue>>
}

async function dispatch(msg: JsonRpcRequest, principal: string): Promise<Handled> {
  switch (msg.method) {
    case 'server/discover':
      return {
        result: completeResult({
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          instructions: '演示用远程服务端：一个同步工具、一个流式工具、一个需要补充输入的工具。',
          ttlMs: 3_600_000,
          cacheScope: 'public',
        }),
      }

    case 'tools/list':
      return {
        result: completeResult({ tools: listTools(), ttlMs: 300_000, cacheScope: 'public' }),
      }

    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(String(msg.params?.name ?? ''))
      if (!tool) {
        // 协议错误：工具名不存在，模型换参数也没用
        return { error: { code: ERR.INVALID_PARAMS, message: `Unknown tool: ${msg.params?.name}` } }
      }
      const args = (msg.params?.arguments as Record<string, JsonValue>) ?? {}
      const base: ToolContext = {
        principal,
        inputResponses: msg.params?.inputResponses as Record<string, JsonValue> | undefined,
        requestState: msg.params?.requestState as string | undefined,
      }
      if (tool.streaming) {
        return { stream: (progress) => tool.run(args, { ...base, progress }) }
      }
      return { result: await tool.run(args, base) }
    }

    default:
      return {
        notFound: true,
        error: { code: ERR.METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` },
      }
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * 练习 2 的落点：事件流分支。
 * 规范允许服务端逐请求决定回单个 JSON 还是开一条 SSE；流上可以先发与本请求相关的通知，
 * 但绝不能发独立的 JSON-RPC 请求，最后由响应终止这条流。
 */
async function sendStream(
  res: http.ServerResponse,
  id: string | number,
  progressToken: JsonValue,
  run: (progress: ToolContext['progress']) => Promise<Record<string, JsonValue>>
) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // 让 nginx 之类的反代不要缓冲，否则进度会攒着一起到
    'x-accel-buffering': 'no',
  })
  res.write(':\n\n') // 冒号开头是 SSE 注释行，用作保活，客户端必须忽略它

  const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  // 客户端没给 progressToken 就不许发进度通知
  const progress =
    progressToken === undefined
      ? undefined
      : (u: { progress: number; total?: number; message?: string }) =>
          write({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, ...u },
          })

  try {
    const result = await run(progress)
    write(rpcOk(id, result))
  } catch (e) {
    write(rpcErr(id, { code: ERR.INTERNAL, message: (e as Error).message }))
  }
  res.end() // 最终响应终止这条流
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) reject(new Error('请求体过大'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    // 运维用的健康检查，不属于 MCP 端点
    if (req.method === 'GET' && req.url === '/healthz') return sendJson(res, 200, { ok: true })

    if (!req.url || !req.url.startsWith(MCP_PATH)) return sendJson(res, 404, { error: 'not found' })

    // 老客户端会来开 GET 长连接或 DELETE 会话；这一版两者都没有了
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405, { allow: 'POST' })
      return res.end()
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })

    if (!originAllowed(req.headers.origin)) {
      return sendJson(
        res,
        403,
        rpcErr(null, { code: ERR.INVALID_PARAMS, message: 'Origin 不被允许' })
      )
    }

    let msg: JsonRpcRequest
    try {
      msg = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, rpcErr(null, { code: -32700, message: 'Parse error' }))
    }

    // 通知没有 id，接受就回 202 且不带 body
    if (msg.id === undefined) {
      res.writeHead(202)
      return res.end()
    }
    const id = msg.id

    const metaError = checkMeta(msg)
    if (metaError) return sendJson(res, 400, rpcErr(id, metaError))

    const headerError = checkHeaders(req.headers, msg)
    if (headerError) return sendJson(res, 400, rpcErr(id, headerError))

    // 真实部署里 principal 来自校验过的访问令牌，这里为了离线可跑用一个固定值
    const principal = process.env.DEMO_PRINCIPAL ?? 'user_demo'
    const handled = await dispatch(msg, principal)

    if (handled.notFound) return sendJson(res, 404, rpcErr(id, handled.error!))
    if (handled.error) return sendJson(res, 400, rpcErr(id, handled.error))
    if (handled.stream) {
      const token = (msg.params?._meta as Record<string, JsonValue> | undefined)?.progressToken
      return sendStream(res, id, token, handled.stream)
    }
    return sendJson(res, 200, rpcOk(id, handled.result!))
  })
}

export function startServer(port: number): Promise<http.Server> {
  const server = createServer()
  return new Promise((resolve) => {
    // 本机只绑回环地址，不要绑 0.0.0.0——容器里由 compose 做端口映射
    const host = process.env.BIND_HOST ?? '127.0.0.1'
    server.listen(port, host, () => {
      process.stderr.write(
        `[${SERVER_INFO.name}] 监听 http://${host}:${port}${MCP_PATH}（协议 ${PROTOCOL_VERSION}）\n`
      )
      resolve(server)
    })
  })
}
