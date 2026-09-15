// D5 演示服务端之一：笔记库。按 2026-07-28 规范手写，零依赖、不联网。
// 特意做了两件事：
//   1. 它有一个叫 search 的工具——tickets-server 也有一个，重名是真实发生的。
//   2. tools/list 每页只回 2 个工具，逼客户端真的把分页翻完。
// 许可：MIT
import readline from 'node:readline'

const PROTOCOL_VERSION = '2026-07-28'
const SERVER_INFO = { name: 'notes', version: '0.1.0' }
const PAGE_SIZE = 2

const NOTES = [
  {
    slug: 'mcp-basics',
    title: 'MCP 三角架构',
    tags: ['mcp'],
    body: '宿主、客户端、服务端各管一段。',
  },
  {
    slug: 'stdio',
    title: 'stdio 传输',
    tags: ['mcp', 'transport'],
    body: '一行一条 JSON，stdout 只放协议消息。',
  },
  {
    slug: 'pagination',
    title: '游标分页',
    tags: ['mcp'],
    body: '游标不透明，只有 nextCursor 缺失才是结束。',
  },
  { slug: 'oncall', title: '值班交接', tags: ['ops'], body: '交接时先看未关闭的告警。' },
]

// tools/list 会按 PAGE_SIZE 切页，客户端必须翻完才能看到 list_tags
const TOOLS = [
  {
    name: 'search',
    title: '搜索笔记',
    description: '在团队笔记库里按关键词搜索，返回匹配的笔记标题与摘要。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词，支持中文' } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'read_note',
    title: '读取笔记',
    description: '按 slug 读取一篇笔记的完整正文。',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: '笔记的 slug，例如 mcp-basics' } },
      required: ['slug'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'list_tags',
    title: '列出标签',
    description: '列出笔记库里所有出现过的标签。',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
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

function decodeCursor(cursor) {
  if (cursor === undefined) return 0
  // 游标对客户端不透明，但服务端自己当然知道它是什么
  const raw = Buffer.from(cursor, 'base64url').toString('utf8')
  const offset = Number(raw.replace(/^offset:/, ''))
  if (!raw.startsWith('offset:') || !Number.isInteger(offset) || offset < 0) return null
  return offset
}

function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url')
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
        instructions: '团队笔记库，用于查找内部文档。',
        ttlMs: 3600000,
        cacheScope: 'public',
      })

    case 'tools/list': {
      const offset = decodeCursor(msg.params?.cursor)
      if (offset === null) return fail(msg.id, -32602, '非法游标')
      const page = TOOLS.slice(offset, offset + PAGE_SIZE)
      const next = offset + PAGE_SIZE
      return ok(msg.id, {
        tools: page,
        ...(next < TOOLS.length ? { nextCursor: encodeCursor(next) } : {}),
        ttlMs: 300000,
        cacheScope: 'public',
      })
    }

    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {}
      if (name === 'search') {
        const q = String(args.query ?? '')
        const hits = NOTES.filter(
          (n) => n.title.includes(q) || n.body.includes(q) || n.tags.includes(q)
        )
        const text = hits.length
          ? hits.map((n) => `${n.slug}：${n.title}`).join('\n')
          : `没有匹配「${q}」的笔记。`
        return ok(msg.id, { content: [{ type: 'text', text }], isError: false })
      }
      if (name === 'read_note') {
        const note = NOTES.find((n) => n.slug === args.slug)
        if (!note) {
          return ok(msg.id, {
            content: [
              {
                type: 'text',
                text: `没有 slug 为 ${args.slug} 的笔记。可用：${NOTES.map((n) => n.slug).join('、')}。`,
              },
            ],
            isError: true,
          })
        }
        return ok(msg.id, { content: [{ type: 'text', text: note.body }], isError: false })
      }
      if (name === 'list_tags') {
        const tags = [...new Set(NOTES.flatMap((n) => n.tags))].sort()
        return ok(msg.id, { content: [{ type: 'text', text: tags.join('、') }], isError: false })
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
    process.stderr.write(`[notes] 无法解析的行：${line}\n`) // 日志只能走 stderr
    return
  }
  if (msg.id === undefined) return
  process.stdout.write(JSON.stringify(handle(msg)) + '\n')
})
rl.on('close', () => process.exit(0))
