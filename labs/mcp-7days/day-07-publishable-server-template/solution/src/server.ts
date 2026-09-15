// 一个可发布的 stdio MCP 服务端模板。三个工具刻意做得容易混淆，
// 好让 D7 的评估集有东西可评：搜索、按 slug 读、新建。
import { fail, ok, type JsonValue, type McpToolDef } from './protocol.js'
import { metrics } from './metrics.js'

interface Doc {
  slug: string
  title: string
  body: string
}

const DOCS: Doc[] = [
  { slug: 'release-process', title: '发布流程', body: '先冻结分支，再跑评估集，最后打标签。' },
  { slug: 'oncall-handbook', title: '值班手册', body: '交接时先看未关闭的告警。' },
  { slug: 'pagination', title: '游标分页', body: '游标不透明，只有 nextCursor 缺失才是结束。' },
]

export const TOOLS: McpToolDef[] = [
  {
    name: 'search_docs',
    title: '搜索文档',
    description:
      '在内部文档库里按关键词搜索，返回匹配的文档 slug 与标题。不知道 slug 时用这个；已经知道 slug 就直接用 get_doc。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词，支持中文' } },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { hits: { type: 'array', items: { type: 'string' } } },
      required: ['hits'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'get_doc',
    title: '读取文档',
    description: '按 slug 读取一篇文档的完整正文。只有已经知道确切 slug 时才用它，不要拿它去猜。',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: '文档 slug，例如 release-process' } },
      required: ['slug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'create_doc',
    title: '新建文档',
    description: '新建一篇文档。这是写操作，会在文档库里留下一条新记录。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题' },
        body: { type: 'string', description: '正文' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
]

function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return ascii || `doc-${DOCS.length + 1}`
}

function runTool(name: string, args: Record<string, JsonValue>): Record<string, JsonValue> {
  if (name === 'search_docs') {
    const q = String(args.query ?? '')
    const hits = DOCS.filter((d) => d.title.includes(q) || d.body.includes(q) || d.slug.includes(q))
    return {
      content: [
        {
          type: 'text',
          text: hits.length
            ? hits.map((d) => `${d.slug}：${d.title}`).join('\n')
            : `没有匹配「${q}」的文档。`,
        },
      ],
      structuredContent: { hits: hits.map((d) => d.slug) },
      isError: false,
    }
  }
  if (name === 'get_doc') {
    const doc = DOCS.find((d) => d.slug === args.slug)
    if (!doc) {
      // 工具执行错误：文案写成对模型有用的样子，它换个 slug 就有可能成功
      return {
        content: [
          {
            type: 'text',
            text: `没有 slug 为 ${String(args.slug)} 的文档。可用：${DOCS.map((d) => d.slug).join('、')}。`,
          },
        ],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: doc.body }], isError: false }
  }
  if (name === 'create_doc') {
    const title = String(args.title ?? '').trim()
    if (!title) {
      return { content: [{ type: 'text', text: '标题不能为空。' }], isError: true }
    }
    const doc: Doc = { slug: slugify(title), title, body: String(args.body ?? '') }
    DOCS.push(doc)
    return { content: [{ type: 'text', text: `已创建 ${doc.slug}。` }], isError: false }
  }
  throw new Error(`Unknown tool: ${name}`)
}

/** 处理一条 JSON-RPC 消息。导出它是为了让自测能直接调，不用起子进程。 */
export function handle(msg: {
  id?: number
  method?: string
  params?: Record<string, JsonValue>
}): Record<string, JsonValue> {
  const id = msg.id ?? 0
  const meta = (msg.params?._meta ?? {}) as Record<string, JsonValue>
  if (!meta['io.modelcontextprotocol/protocolVersion']) {
    return fail(id, -32602, '缺少 io.modelcontextprotocol/protocolVersion')
  }

  switch (msg.method) {
    case 'server/discover':
      return ok(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        instructions: '内部文档库。先搜再读，别拿 get_doc 猜 slug。',
        ttlMs: 3600000,
        cacheScope: 'public',
      })

    case 'tools/list':
      return ok(id, { tools: TOOLS as unknown as JsonValue, ttlMs: 300000, cacheScope: 'public' })

    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, JsonValue>
      if (!TOOLS.some((t) => t.name === name)) {
        // 工具不存在是协议错误：模型改不了，别伪装成工具结果
        metrics.record(name || '(unknown)', 0, true)
        return fail(id, -32602, `Unknown tool: ${name}`)
      }
      // 可观测的最小闭环：每次调用记一次耗时与是否出错
      const started = performance.now()
      try {
        const result = runTool(name, args)
        metrics.record(name, performance.now() - started, result.isError === true)
        return ok(id, result)
      } catch (error) {
        metrics.record(name, performance.now() - started, true)
        return fail(id, -32603, error instanceof Error ? error.message : String(error))
      }
    }

    default:
      return fail(id, -32601, `Method not found: ${String(msg.method)}`)
  }
}
