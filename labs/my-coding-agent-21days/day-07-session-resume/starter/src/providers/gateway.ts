/**
 * OpenAI 兼容网关的 provider。★ D2 定稿，之后十九天逐字不变。
 *
 * 它只做一件事：把一次 HTTP 流式响应翻译成 StreamDelta 序列。
 * 三个容易做错的地方都在这里处理掉了：
 *   1. SSE 的事件边界是空行，不是换行——一条事件可以有多行 data
 *   2. 网络分块与事件边界无关，所以必须留 buffer，半行报文要等下一块
 *   3. 流可能在没有结束事件的情况下断掉，这要报成一个可重试的错误，而不是静静收尾
 */
import type { ChatProvider, ChatRequest, StreamDelta } from './types.js'
import { contentToText } from '../kernel/types.js'
import type { ToolDef } from '../kernel/types.js'

/** 流在中途断开：没有收到 finish，也没有收到 [DONE] */
export class StreamTruncatedError extends Error {
  readonly retryable = true
  constructor(received: number) {
    super(`流在中途断开（已收到 ${received} 个分片，但没有结束事件）`)
    this.name = 'StreamTruncatedError'
  }
}

/** 网关限流：调用方应该退避后重试（D6 会用到 retryAfterMs） */
export class RateLimitError extends Error {
  readonly retryable = true
  constructor(readonly retryAfterMs: number) {
    super(`网关限流（建议 ${retryAfterMs}ms 后重试）`)
    this.name = 'RateLimitError'
  }
}

export class GatewayProvider implements ChatProvider {
  readonly id = 'gateway'

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly model: string
  ) {}

  async *stream(req: ChatRequest): AsyncIterable<StreamDelta> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        // 带上它，末尾那条事件才会回传 usage（D12 数 token、D20 算缓存命中都要用）
        stream_options: { include_usage: true },
        messages: req.messages.map(toWireMessage),
        ...(req.tools?.length
          ? { tools: req.tools.map(toWireTool), tool_choice: 'auto', parallel_tool_calls: true }
          : {}),
      }),
      signal: req.signal,
    })

    if (res.status === 429) {
      throw new RateLimitError(parseRetryAfter(res.headers.get('retry-after')))
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`网关返回 ${res.status}：${detail.slice(0, 200)}`)
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let received = 0
    let closed = false

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      // 事件之间由空行分隔。兼容 CRLF：先把 \r\n 归一成 \n 再找 \n\n
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const payload of dataLines(raw)) {
          if (payload === '[DONE]') {
            closed = true
            return
          }
          for (const delta of parseChunk(payload)) {
            received += 1
            if (delta.type === 'finish') closed = true
            yield delta
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }

    // 走到这里说明字节流结束了。没见过 finish 也没见过 [DONE] 就是断流。
    if (!closed) throw new StreamTruncatedError(received)
  }
}

function toWireMessage(m: ChatRequest['messages'][number]): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role, content: contentToText(m.content) }
  if (m.toolCallId) base.tool_call_id = m.toolCallId
  if (m.name) base.name = m.name
  if (m.toolCalls?.length) {
    base.tool_calls = m.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    }))
  }
  return base
}

function toWireTool(tool: ToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

/** 一条 SSE 事件里可以有多行 data，按规范要把它们用换行拼起来 */
function dataLines(rawEvent: string): string[] {
  const lines: string[] = []
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith(':')) continue // 注释行（心跳），丢掉
    if (!line.startsWith('data:')) continue
    lines.push(line.slice(5).trimStart())
  }
  // 按规范，一条事件里的多行 data 用换行拼成一个载荷
  return lines.length ? [lines.join('\n')] : []
}

/** 只声明我们用到的字段：网关加字段不会把我们弄坏 */
interface ChunkShape {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/** 一条事件可能同时含文本、工具分片、用量，所以返回数组 */
function parseChunk(payload: string): StreamDelta[] {
  let data: ChunkShape
  try {
    data = JSON.parse(payload) as ChunkShape
  } catch {
    return [] // 不是合法 JSON 就丢掉：正常流里不会出现，出现了也不该让整轮崩
  }

  const deltas: StreamDelta[] = []
  const choice = data.choices?.[0]

  if (choice?.delta?.content) deltas.push({ type: 'text', text: choice.delta.content })

  for (const call of choice?.delta?.tool_calls ?? []) {
    deltas.push({
      type: 'tool_call',
      // index 是归并的唯一依据。实测不同模型的起点不同（有的从 0，有的从 1），
      // 所以这里原样透出，不做任何归一化，也不许调用方按到达顺序拼。
      index: call.index ?? 0,
      id: call.id,
      name: call.function?.name,
      argsDelta: call.function?.arguments,
    })
  }

  if (data.usage) {
    deltas.push({
      type: 'usage',
      promptTokens: data.usage.prompt_tokens ?? 0,
      completionTokens: data.usage.completion_tokens ?? 0,
      cachedTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
    })
  }

  if (choice?.finish_reason) {
    deltas.push({ type: 'finish', reason: normalizeFinish(choice.finish_reason) })
  }

  return deltas
}

function normalizeFinish(reason: string): 'stop' | 'tool_calls' | 'length' | 'other' {
  if (reason === 'stop' || reason === 'tool_calls' || reason === 'length') return reason
  return 'other'
}

function parseRetryAfter(header: string | null): number {
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  return 1000
}
