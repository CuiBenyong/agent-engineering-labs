// 笔记资源服务端。用官方 SDK 的低层 Server 类而不是 McpServer：
// McpServer 的 registerResource 一次只登记一条静态资源，且不给你插手 resources/list 的机会，
// 而今天要教的恰恰就是分页。低层 Server 让我们自己接管每一个方法。
//
// ⚠️ 版本落差（D2 讲过，这里再提醒一次）：@modelcontextprotocol/sdk 1.30.0 的
// LATEST_PROTOCOL_VERSION 仍是 2025-11-25，所以它在线上不会发 resultType，也没有
// server/discover 与 subscriptions/listen。ttlMs / cacheScope 这类新字段能原样透传出去
// （SDK 不校验结果的额外字段），我们照 2026-07-28 的形状写，等 SDK 跟上就能直接用。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { URI_SCHEME, noteUri, notesByTag, scanNotes, slugFromUri } from './notes.js'
import { InvalidCursorError, paginate } from './pagination.js'

/** 缓存提示：清单变得慢，正文变得快，所以两者的 ttl 差一个数量级 */
const LIST_CACHE = { ttlMs: 300_000, cacheScope: 'public' as const }
const READ_CACHE = { ttlMs: 60_000, cacheScope: 'private' as const }

export function buildServer(): Server {
  const server = new Server(
    { name: 'notes-resource-server', version: '0.1.0' },
    {
      // 声明能力：我们有资源和提示模板，资源清单会变但不支持逐条订阅
      capabilities: {
        resources: { listChanged: true },
        prompts: { listChanged: false },
      },
      instructions: '把一份本地 Markdown 笔记库暴露成 MCP 资源，并提供一个按标签汇总的提示模板。',
    }
  )

  // ---- 资源清单：静态资源的写法（逐条列出来，可枚举、可被用户挑）----
  server.setRequestHandler(ListResourcesRequestSchema, async (req) => {
    const all = await scanNotes()
    const page = paginate(all, req.params?.cursor)
    return {
      resources: page.items.map((n) => ({
        uri: noteUri(n.slug),
        name: n.slug,
        title: n.title,
        description: n.tags.length ? `标签：${n.tags.join('、')}` : undefined,
        mimeType: 'text/markdown',
        annotations: { audience: ['user', 'assistant'], priority: 0.5 },
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...LIST_CACHE,
    }
  })

  // ---- 资源模板：URI 模板的写法（一条定义顶一整组资源）----
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    // 练习 3：用一条 RFC 6570 的 URI 模板顶掉一整组资源。
    //   提示：形如 notes:///{slug}，其中 {slug} 这一段可以被客户端的补全接口提示出来。
    //   现在返回空数组，自测第 4 项会红。
    resourceTemplates: [] as { uriTemplate: string; name: string; mimeType?: string }[],
    ...LIST_CACHE,
  }))

  // ---- 读取正文 ----
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const slug = slugFromUri(req.params.uri)
    // 资源不存在这一版统一用 -32602（旧版是 -32002），且绝不能回空 contents 数组
    if (!slug) throw new InvalidResourceError(req.params.uri)
    const note = (await scanNotes()).find((n) => n.slug === slug)
    if (!note) throw new InvalidResourceError(req.params.uri)
    return {
      contents: [{ uri: req.params.uri, mimeType: 'text/markdown', text: note.body }],
      ...READ_CACHE,
    }
  })

  // ---- 提示模板：用户控制的那一类原语，客户端通常渲染成斜杠命令 ----
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'digest_by_tag',
        title: '按标签汇总笔记',
        description: '把某个标签下的所有笔记聚起来，让模型写一段摘要',
        arguments: [{ name: 'tag', description: '标签名，例如 mcp', required: true }],
      },
    ],
    ...LIST_CACHE,
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const tag = req.params.arguments?.tag
    // 缺必填参数用 -32602，和无效提示模板名同一个码
    if (!tag) throw new InvalidPromptArgsError('缺少必填参数 tag')
    // 练习 4：按标签筛出笔记，并在返回的消息里为每一篇附一条 resource_link。
    //   提示一：notesByTag 已经写好了，直接用。
    //   提示二：用 resource_link 而不是把正文整段塞进来——链接让宿主自己决定要不要真去读，
    //           正文进不进上下文由应用说了算，这正是「资源是应用驱动」在报文层面的样子。
    //   现在只回一条纯文本，自测第 5 项会红。
    void notesByTag
    void noteUri
    return {
      description: `（练习 4 还没做：这里应该带上标签 ${tag} 命中的笔记）`,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `请把下面这些笔记汇总成一段不超过 200 字的要点，标签是「${tag}」。`,
          },
        },
      ],
    }
  })

  return server
}

/** SDK 会把抛出的 McpError 转成 JSON-RPC 错误；这里用最小实现表达同样的意思 */
class InvalidResourceError extends Error {
  readonly code = -32602
  constructor(uri: string) {
    super(`Resource not found: ${uri}`)
  }
}

class InvalidPromptArgsError extends Error {
  readonly code = -32602
}

export { InvalidCursorError }
