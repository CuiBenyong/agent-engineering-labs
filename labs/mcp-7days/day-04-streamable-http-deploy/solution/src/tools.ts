// 三个工具，分别演示三种响应形态：单个 JSON、事件流、需要客户端补充输入。
import {
  type JsonValue,
  completeResult,
  inputRequiredResult,
  signRequestState,
  verifyRequestState,
} from './protocol.js'

export interface ProgressSink {
  (update: { progress: number; total?: number; message?: string }): void
}

export interface ToolContext {
  /** 只有客户端在 _meta 里给了 progressToken 时才会被赋值——规范禁止发客户端没要的进度。 */
  progress?: ProgressSink
  inputResponses?: Record<string, JsonValue>
  requestState?: string
  /** 真实部署里来自校验过的令牌，绝不能取自客户端自报的 clientInfo。 */
  principal: string
}

export interface ToolSpec {
  name: string
  title: string
  description: string
  inputSchema: Record<string, JsonValue>
  outputSchema?: Record<string, JsonValue>
  annotations?: Record<string, JsonValue>
  /** 服务端自己决定这个工具用事件流回；客户端两种都必须支持。 */
  streaming?: boolean
  run(args: Record<string, JsonValue>, ctx: ToolContext): Promise<Record<string, JsonValue>>
}

const textResult = (text: string, extra: Record<string, JsonValue> = {}) =>
  completeResult({ content: [{ type: 'text', text }], isError: false, ...extra })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const TOOLS: ToolSpec[] = [
  {
    name: 'echo_upper',
    title: '转成大写',
    description: '把 text 转成大写后原样返回。用于验证连通性，没有副作用。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要转换的文本' } },
      required: ['text'],
    },
    outputSchema: {
      type: 'object',
      properties: { upper: { type: 'string' } },
      required: ['upper'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async run(args) {
      const text = String(args.text ?? '')
      const upper = text.toUpperCase()
      return textResult(JSON.stringify({ upper }), { structuredContent: { upper } })
    },
  },

  {
    name: 'analyze_corpus',
    title: '慢速语料统计',
    description: '分批统计一批文档的词数，耗时较长，会边算边上报进度。documents 传字符串数组。',
    inputSchema: {
      type: 'object',
      properties: {
        documents: { type: 'array', items: { type: 'string' }, description: '待统计的文档' },
      },
      required: ['documents'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    streaming: true,
    async run(args, ctx) {
      const docs = Array.isArray(args.documents) ? (args.documents as string[]) : []
      if (docs.length === 0) {
        // 工具执行错误：模型换个参数就有可能成功，所以走 isError 而不是 JSON-RPC error
        return completeResult({
          content: [{ type: 'text', text: 'documents 不能为空，请至少传一篇文档。' }],
          isError: true,
        })
      }
      let words = 0
      for (let i = 0; i < docs.length; i++) {
        await sleep(30) // 假装在算，好让进度通知真的分几次发出去
        words += docs[i].split(/\s+/).filter(Boolean).length
        // progress 必须单调递增；total 可选；message 是给人看的
        ctx.progress?.({ progress: i + 1, total: docs.length, message: `已统计 ${i + 1} 篇` })
      }
      const summary = { documents: docs.length, words }
      return textResult(JSON.stringify(summary), { structuredContent: summary })
    },
  },

  {
    name: 'book_meeting',
    title: '预约会议',
    description: '按主题预约一次会议。缺少参会人邮箱时会先向用户索要，拿到之后才真正创建。',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: '会议主题' } },
      required: ['topic'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async run(args, ctx) {
      const topic = String(args.topic ?? '')
      const answer = ctx.inputResponses?.attendee_email as
        { action?: string; content?: { email?: string } } | undefined

      if (!answer) {
        // 第一轮：服务端不能自己发 JSON-RPC 请求，只能把请求塞进结果里让客户端重试
        return inputRequiredResult({
          inputRequests: {
            attendee_email: {
              method: 'elicitation/create',
              params: {
                mode: 'form',
                message: `为「${topic}」预约会议，请提供参会人邮箱`,
                requestedSchema: {
                  type: 'object',
                  properties: { email: { type: 'string', format: 'email' } },
                  required: ['email'],
                },
              },
            },
          },
          // 把服务端这一侧的上下文签进 state，重试时不需要任何服务端存储
          requestState: signRequestState({
            principal: ctx.principal,
            origin: 'tools/call:book_meeting',
            exp: Date.now() + 5 * 60_000,
            data: { topic },
          }),
        })
      }

      if (answer.action !== 'accept') {
        return textResult('用户没有提供邮箱，会议未创建。')
      }

      // 第二轮：state 必须验签，验不过一律拒绝
      const state = ctx.requestState
        ? verifyRequestState(ctx.requestState, {
            principal: ctx.principal,
            origin: 'tools/call:book_meeting',
          })
        : null
      if (!state) {
        return completeResult({
          content: [{ type: 'text', text: 'requestState 校验失败，请重新发起预约。' }],
          isError: true,
        })
      }

      const booked = {
        topic: String(state.data.topic ?? topic),
        attendee: String(answer.content?.email ?? ''),
        id: `mtg_${Math.random().toString(36).slice(2, 10)}`,
      }
      return textResult(JSON.stringify(booked), { structuredContent: booked })
    },
  },
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** tools/list 要返回确定性顺序，客户端和模型的提示缓存都靠它。 */
export function listTools() {
  return [...TOOLS]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      ...(annotations ? { annotations } : {}),
    }))
}
