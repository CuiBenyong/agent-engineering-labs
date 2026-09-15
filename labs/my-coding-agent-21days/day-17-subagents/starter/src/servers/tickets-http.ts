/**
 * 演示用的 Streamable HTTP MCP server：一个假的「工单系统」。本天新增。
 *
 * 它同样不是练习，是**你的连接对象**。存在的意义是让 HTTP 那一侧的三件事看得见：
 *
 *   1. **必填请求头**：MCP-Protocol-Version / Mcp-Method / Mcp-Name 把请求体里的
 *      关键字段镜像到头上，让网关不必解析请求体就能路由。既然中间层按头做决策、
 *      服务端按体做执行，**两边不一致就是一个漏洞**——所以这里会校验，
 *      不一致回 400 加 -32020。
 *   2. **两种响应形状**：tools/list 回 application/json，tools/call 回 text/event-stream
 *      （中间夹一条进度通知，最后一条才是带 id 的响应）。
 *   3. **老协议的三样东西都没了**：GET 打过来回 405（上一版用 GET 开长连接收推送），
 *      Mcp-Session-Id 收到就忽略，Last-Event-ID 也忽略、流不可续传。
 *
 * 它还和笔记库撞了一个 search，这是命名空间那一节的素材。
 */
import http from 'node:http'
import { PROTOCOL_VERSION } from '../mcp/protocol.js'

export const TICKETS_PORT = 3115

const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const NAMED_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get'])

const TICKETS = [
  { id: 'T-1001', title: 'divide(1, 0) 返回 Infinity 导致报表出现无穷大', status: 'open' },
  { id: 'T-1002', title: '测试用例 divide by zero 一直是红的', status: 'open' },
  { id: 'T-0087', title: '文档里少写了除零约定', status: 'closed' },
]

const TOOLS = [
  {
    name: 'search',
    description: '在工单系统里按关键词搜工单，返回工单号、标题与状态。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '关键词' } },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'close_ticket',
    description: '关闭一个工单。这是一个会改变对方系统状态的操作。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工单号，例如 T-1001' },
        reason: { type: 'string', description: '关闭原因' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    // 注意这里**故意**没写 destructiveHint。客户端本来就不该依赖它，
    // 所以少一个注解不该改变任何行为——远端工具一律要过审批门
    annotations: {},
  },
]

/** HTTP 头值只允许可见 ASCII，非 ASCII 走这个哨兵格式。**必须先解码再比对** */
function decodeHeaderValue(raw: string): string {
  const match = /^=\?base64\?(.*)\?=$/.exec(raw)
  if (!match) return raw
  return Buffer.from(match[1] as string, 'base64').toString('utf8')
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return { resultType: 'complete', content: [{ type: 'text', text }], isError }
}

interface RpcMessage {
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

function callTool(params: Record<string, unknown>): Record<string, unknown> | null {
  const args = (params.arguments ?? {}) as Record<string, unknown>
  if (params.name === 'search') {
    const query = String(args.query ?? '')
    const hits = TICKETS.filter((t) => t.title.includes(query) || t.id.includes(query))
    if (hits.length === 0) return textResult(`没有命中「${query}」的工单。`)
    return textResult(hits.map((t) => `${t.id} [${t.status}] ${t.title}`).join('\n'))
  }
  if (params.name === 'close_ticket') {
    const ticket = TICKETS.find((t) => t.id === String(args.id ?? ''))
    if (!ticket) return textResult(`没有工单 ${String(args.id)}。`, true)
    ticket.status = 'closed'
    return textResult(`${ticket.id} 已关闭。原因：${String(args.reason ?? '（未填）')}`)
  }
  return null
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

/** 校验三个必填头与请求体是否一致。返回一句话说明哪里不一致，全对就返回 null */
function headerMismatch(req: http.IncomingMessage, msg: RpcMessage): string | null {
  const method = decodeHeaderValue(String(req.headers['mcp-method'] ?? ''))
  if (method !== (msg.method ?? ''))
    return `Mcp-Method 头是「${method}」，请求体里是「${msg.method}」`
  if (msg.method && NAMED_METHODS.has(msg.method)) {
    const params = msg.params ?? {}
    const target = String(params.name ?? params.uri ?? '')
    const header = decodeHeaderValue(String(req.headers['mcp-name'] ?? ''))
    if (header !== target) return `Mcp-Name 头是「${header}」，请求体里是「${target}」`
  }
  return null
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, msg: RpcMessage): void {
  const id = msg.id ?? null
  const params = msg.params ?? {}
  const meta = (params._meta ?? {}) as Record<string, unknown>

  if (meta[META_VERSION] !== PROTOCOL_VERSION) {
    const message = `不支持的协议版本，本 server 只支持 ${PROTOCOL_VERSION}`
    send(res, 400, { jsonrpc: '2.0', id, error: { code: -32022, message } })
    return
  }
  const mismatch = headerMismatch(req, msg)
  if (mismatch) {
    send(res, 400, {
      jsonrpc: '2.0',
      id,
      error: { code: -32020, message: `头体不一致：${mismatch}` },
    })
    return
  }

  if (msg.method === 'server/discover') {
    send(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        serverInfo: { name: 'demo-tickets', version: '0.1.0' },
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
      },
    })
    return
  }

  // tools/list 用普通 JSON 回：它不会慢，没有必要开一条流
  if (msg.method === 'tools/list') {
    send(res, 200, {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS, ttlMs: 60000, cacheScope: 'session' },
    })
    return
  }

  // tools/call 用事件流回：先一条进度通知，再一条带 id 的响应。
  // **客户端不能假设「最后一条就是响应」**，判据是 id 对得上
  if (msg.method === 'tools/call') {
    const result = callTool(params)
    if (!result) {
      send(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `没有名为 ${String(params.name)} 的工具` },
      })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      // 不加这个头，nginx 之类的反代会把事件攒着一起发，流就不流了
      'x-accel-buffering': 'no',
    })
    res.write(':\n\n') // 冒号开头是 SSE 注释行，用作保活，客户端必须忽略
    const progress = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: id, progress: 1, total: 1, message: '正在查工单系统' },
    }
    res.write(`data: ${JSON.stringify(progress)}\n\n`)
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
    res.end()
    return
  }

  // 方法不存在回 404 而不是 400：客户端才能把「这个端点不认识这个方法」
  // 和「这个地址根本没有 MCP 端点」区分开
  send(res, 404, { jsonrpc: '2.0', id, error: { code: -32601, message: `没有实现 ${msg.method}` } })
}

export function startTicketServer(port = TICKETS_PORT): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    // 这一版删掉了 GET 长连接与 DELETE 终止会话，所以两者都回 405
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' })
      res.end('只支持 POST')
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      let msg: RpcMessage
      try {
        msg = JSON.parse(body) as RpcMessage
      } catch {
        send(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: '请求体不是合法 JSON' },
        })
        return
      }
      // 没有 id 的是通知：接受了就回 202，没有响应体
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202).end()
        return
      }
      handle(req, res, msg)
    })
  })
  return new Promise((resolve) => server.listen(port, () => resolve(server)))
}

// 直接跑这个文件时就起服务（tsx src/servers/tickets-http.ts），
// 被 import 时只导出 startTicketServer
if (process.argv[1] && process.argv[1].endsWith('tickets-http.ts')) {
  await startTicketServer()
  process.stdout.write(`工单系统 MCP server 已启动：http://127.0.0.1:${TICKETS_PORT}/mcp\n`)
}
