/**
 * OpenAI 兼容网关的 provider。今天是最小版本：只解析文本增量。
 *
 * 明天（D2）会把它扩成正式版本——处理工具调用分片、用量、半行报文与流中断，
 * 并从那一天起成为二十天不变的权威副本。今天先看清最小骨架：
 * 一次 POST、一段 SSE、一串增量。
 */
import type { ChatProvider, ChatRequest, StreamDelta } from './types.js'
import { contentToText } from '../kernel/types.js'

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
        messages: req.messages.map((m) => ({ role: m.role, content: contentToText(m.content) })),
      }),
      signal: req.signal,
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`网关返回 ${res.status}：${detail.slice(0, 200)}`)
    }

    // SSE 是文本协议：一条事件以空行结束，事件里的 data: 行才是我们要的载荷。
    // 今天只按行读，够用；明天会换成按空行分帧的正式解析器。
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // 最后一段可能是半行，留到下一轮
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') return
        const delta = parseChunk(payload)
        if (delta) yield delta
      }
    }
  }
}

/** 只声明我们用到的字段：多余的字段不解析，网关加字段也不会把我们弄坏 */
interface ChunkShape {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

function parseChunk(payload: string): StreamDelta | null {
  let data: ChunkShape
  try {
    data = JSON.parse(payload) as ChunkShape
  } catch {
    return null // 半个 JSON 就丢掉：正式版本会把它留到下一片再拼
  }
  if (data.usage) {
    return {
      type: 'usage',
      promptTokens: data.usage.prompt_tokens ?? 0,
      completionTokens: data.usage.completion_tokens ?? 0,
      cachedTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
    }
  }
  const choice = data.choices?.[0]
  if (choice?.delta?.content) return { type: 'text', text: choice.delta.content }
  if (choice?.finish_reason) return { type: 'finish', reason: normalizeFinish(choice.finish_reason) }
  return null
}

function normalizeFinish(reason: string): 'stop' | 'tool_calls' | 'length' | 'other' {
  if (reason === 'stop' || reason === 'tool_calls' || reason === 'length') return reason
  return 'other'
}
