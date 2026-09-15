// D5 演示服务端之二：工单系统。按 2026-07-28 规范手写，零依赖、不联网。
// 特意做了两件事：
//   1. 它也有一个叫 search 的工具——和 notes-server 撞名，客户端必须自己消歧。
//   2. 设了环境变量 SLOW_MS 就把每条响应都推迟这么多毫秒，用来验客户端的超时与降级。
// 许可：MIT
import readline from 'node:readline'

const PROTOCOL_VERSION = '2026-07-28'
const SERVER_INFO = { name: 'tickets', version: '0.1.0' }
const SLOW_MS = Number(process.env.SLOW_MS ?? 0)

const TICKETS = [
  { id: 'T-1001', title: '登录页 500', status: 'open', owner: 'ann' },
  { id: 'T-1002', title: '导出 CSV 乱码', status: 'open', owner: 'bo' },
  { id: 'T-1003', title: '搜索结果排序错乱', status: 'closed', owner: 'ann' },
]

const TOOLS = [
  {
    name: 'search',
    title: '搜索工单',
    description: '在工单系统里按关键词或状态搜索工单，返回工单号与标题。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，支持中文；也可以传 open 或 closed 按状态筛',
        },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'close_ticket',
    title: '关闭工单',
    description: '把一个工单标记为已关闭。这是写操作，关闭之后需要人工才能重开。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '工单号，形如 T-1001' } },
      required: ['id'],
    },
    // 注意这两个提示：客户端拿它决定要不要弹确认框，但规范要求把注解当成不可信输入
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
]

function ok(id, result) {
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

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function handle(msg) {
  const meta = msg.params?._meta ?? {}
  if (!meta['io.modelcontextprotocol/protocolVersion']) {
    return fail(msg.id, -32602, '缺少 io.modelcontextprotocol/protocolVersion')
  }
  if (meta['io.modelcontextprotocol/protocolVersion'] !== PROTOCOL_VERSION) {
    return fail(msg.id, -32022, `不支持的协议版本，本服务端只支持 ${PROTOCOL_VERSION}`)
  }
  if (meta['io.modelcontextprotocol/clientCapabilities'] === undefined) {
    return fail(msg.id, -32602, '缺少 io.modelcontextprotocol/clientCapabilities')
  }

  switch (msg.method) {
    case 'server/discover':
      return ok(msg.id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions: '内部工单系统，可查询与关闭工单。',
        ttlMs: 3600000,
        cacheScope: 'public',
      })

    case 'tools/list':
      // 这个服务端工具少，一页就发完了，所以不带 nextCursor
      return ok(msg.id, { tools: TOOLS, ttlMs: 300000, cacheScope: 'public' })

    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {}
      if (name === 'search') {
        const q = String(args.query ?? '')
        const hits = TICKETS.filter((t) => t.title.includes(q) || t.status === q || t.id === q)
        const text = hits.length
          ? hits.map((t) => `${t.id}（${t.status}）：${t.title}`).join('\n')
          : `没有匹配「${q}」的工单。`
        return ok(msg.id, { content: [{ type: 'text', text }], isError: false })
      }
      if (name === 'close_ticket') {
        const ticket = TICKETS.find((t) => t.id === args.id)
        if (!ticket) {
          // 工具执行错误：文案写成对模型有用的样子，它换个参数就有可能成功
          return ok(msg.id, {
            content: [
              {
                type: 'text',
                text: `没有工单 ${args.id}。当前未关闭的工单：${TICKETS.filter(
                  (t) => t.status === 'open'
                )
                  .map((t) => t.id)
                  .join('、')}。`,
              },
            ],
            isError: true,
          })
        }
        ticket.status = 'closed'
        return ok(msg.id, {
          content: [{ type: 'text', text: `${ticket.id} 已关闭。` }],
          isError: false,
        })
      }
      return fail(msg.id, -32602, `Unknown tool: ${name}`)
    }

    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`)
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    process.stderr.write(`[tickets] 无法解析的行：${line}\n`)
    return
  }
  if (msg.id === undefined) return
  const reply = JSON.stringify(handle(msg)) + '\n'
  // SLOW_MS 用来模拟一个反应迟钝的服务端，客户端应该超时并降级，而不是卡死整轮对话
  if (SLOW_MS > 0) setTimeout(() => process.stdout.write(reply), SLOW_MS)
  else process.stdout.write(reply)
})
rl.on('close', () => process.exit(0))
