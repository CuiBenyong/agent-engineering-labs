// 演示用的 stdio MCP server：一个假的「团队笔记库」。本天新增。
//
// 它不是练习，是**你的连接对象**。刻意写成纯 .mjs（零依赖、node 直接跑、不经 tsx），
// 因为真实世界里的 MCP server 就是另一个独立程序，跟你的 Agent 不共享任何代码。
//
// 它被故意做坏了两处，两处都是客户端必须扛住的现实：
//   1. tools/list **每页只回 2 个工具**，一共 3 个。写死「取第一页」的客户端会少看见一个，
//      而且不会有任何东西报错。
//   2. 它有一个叫 search 的工具，和 HTTP 那个 server 撞名。
//
// 一条铁律在这个文件里体现得最直白：**日志只能走 stderr**。往 stdout 多打一个字，
// 对面的 JSON.parse 就开始报错，而报出来的错长得像「协议坏了」，跟日志毫无关系。
import process from 'node:process'

const PROTOCOL_VERSION = '2026-07-28'
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const PAGE_SIZE = 2

const NOTES = {
  'divide-convention': {
    tags: ['calc', '约定'],
    body: '团队约定：除法遇到除数为 0 时抛错，不要返回 Infinity。历史上有一次线上事故就是\nInfinity 一路传到了报表里，没有任何地方报错。',
  },
  'test-policy': {
    tags: ['测试'],
    body: '测试是验收标准。不允许为了让测试变绿去改测试，只能改被测代码。',
  },
  'big-dump': {
    tags: ['归档'],
    // 一份刻意很长的笔记：用来看远端工具的结果**照样**走本地那条 8000 字符的截断
    body: Array.from(
      { length: 400 },
      (_, i) => `第 ${i + 1} 行归档内容，这一行是凑长度用的。`
    ).join('\n'),
  },
}

const TOOLS = [
  {
    name: 'search',
    description: '在团队笔记库里按关键词搜笔记，返回命中的笔记标题与摘要。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '关键词' } },
      required: ['query'],
      additionalProperties: false,
    },
    // 服务端的自我声明。客户端**不拿它当权限用**，理由见 mcp/mount.ts 的文件头
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_note',
    description: '按标题读一篇团队笔记的全文。',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: '笔记标题' } },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_tags',
    description: '列出笔记库里用过的全部标签。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
]

function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function textResult(text, isError = false) {
  // resultType 在这一版里区分「做完了」与「还要你补东西」。我们永远是做完了
  return { resultType: 'complete', content: [{ type: 'text', text }], isError }
}

function listTools(params) {
  const start = params.cursor ? Number(params.cursor) : 0
  const page = TOOLS.slice(start, start + PAGE_SIZE)
  const next = start + PAGE_SIZE
  return {
    tools: page,
    // **nextCursor 缺失才是结束。** 游标对客户端不透明，我们这里用的是下标，
    // 但客户端不许知道这件事，更不许自己构造游标
    ...(next < TOOLS.length ? { nextCursor: String(next) } : {}),
    // 2026-07-28 起列表类结果要带缓存提示
    ttlMs: 60000,
    cacheScope: 'session',
  }
}

function callTool(params) {
  const args = params.arguments ?? {}
  if (params.name === 'search') {
    const query = String(args.query ?? '')
    const hits = Object.entries(NOTES).filter(
      ([title, note]) => title.includes(query) || note.body.includes(query)
    )
    if (hits.length === 0) return textResult(`笔记库里没有命中「${query}」的笔记。`)
    return textResult(hits.map(([title, n]) => `- ${title}：${n.body.slice(0, 40)}…`).join('\n'))
  }
  if (params.name === 'read_note') {
    const note = NOTES[String(args.title ?? '')]
    // 工具自己的失败要回 isError 为真的**成功响应**，不是 JSON-RPC 错误。
    // 前者模型看得见、能改口；后者是程序的 bug，模型改不了
    if (!note)
      return textResult(
        `没有叫「${args.title}」的笔记。可用的是：${Object.keys(NOTES).join('、')}`,
        true
      )
    return textResult(note.body)
  }
  if (params.name === 'list_tags') {
    const tags = new Set(Object.values(NOTES).flatMap((n) => n.tags))
    return textResult([...tags].join('、'))
  }
  return null
}

function handle(msg) {
  const id = msg.id
  const params = msg.params ?? {}
  const version = (params._meta ?? {})[META_VERSION]
  // 无状态协议下版本写在每条请求里，所以每条请求都要校验。不支持就回 -32022
  if (version !== PROTOCOL_VERSION) {
    return fail(id, -32022, `不支持的协议版本 ${version}，本 server 只支持 ${PROTOCOL_VERSION}`)
  }
  if (msg.method === 'server/discover') {
    return ok(id, {
      serverInfo: { name: 'demo-notes', version: '0.1.0' },
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: '这是一个只读的团队笔记库，适合在动手改代码之前查团队约定。',
    })
  }
  if (msg.method === 'tools/list') return ok(id, listTools(params))
  if (msg.method === 'tools/call') {
    const result = callTool(params)
    if (!result) return fail(id, -32602, `没有名为 ${params.name} 的工具`)
    return ok(id, result)
  }
  return fail(id, -32601, `没有实现 ${msg.method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stderr.write(`收到无法解析的一行：${line.slice(0, 80)}\n`)
      continue
    }
    // 没有 id 的是通知：处理它，但**绝不回复**。给通知回一条响应，
    // 对面会把它当成某条请求的迟到响应，那种错很难查
    if (msg.id === undefined || msg.id === null) continue
    process.stdout.write(`${JSON.stringify(handle(msg))}\n`)
  }
})

process.stderr.write('notes-stdio server 就绪（日志只走 stderr）\n')
