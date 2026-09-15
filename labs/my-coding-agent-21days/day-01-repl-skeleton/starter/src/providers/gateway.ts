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
    // TODO(1) 发一次流式请求，并把 SSE 解析成 StreamDelta。
    //
    // 要点：
    //   1. POST 到 `${this.baseUrl}/chat/completions`，头里带 authorization 与 content-type
    //   2. 请求体里 stream 为 true，并带上 stream_options: { include_usage: true }，
    //      否则末尾拿不到 usage（D12 数 token、D20 算缓存命中都要用它）
    //   3. messages 用 contentToText 摊平成纯文本（多模态留到 D19）
    //   4. 响应不 ok 时把状态码与响应体前 200 字符一起抛出来，别只抛一句"请求失败"
    //   5. SSE 是文本协议：按行读，只处理以 data: 开头的行，遇到 [DONE] 结束；
    //      每轮把最后一段留在 buffer 里，因为它可能是半行
    //   6. 解析出的每一片交给下面的 parseChunk，非空就 yield
    //
    // 提示：res.body 在 Node 22 里可以直接 for await：
    //   for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) { ... }
    void req
    throw new Error('TODO(1)：还没实现网关 provider。先用 MOCK=1 跑离线剧本。')
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
