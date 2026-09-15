import 'dotenv/config'

/** 一个模型 provider 的配置。超时按 provider 分别设——强模型本来就慢，一刀切会把本可成功的请求掐死。 */
interface Provider {
  name: string
  model: string
  timeoutMs: number
  /** 只在 MOCK=1 下生效：模拟这个 provider 的故障方式 */
  mockFailure?: 'timeout' | 'rate-limit' | 'bad-request'
}

interface Reply {
  text: string
  provider: string
  tokens: number
}

const PROVIDERS: Provider[] = [
  { name: 'fast', model: 'openai/gpt-4o-mini', timeoutMs: 8000, mockFailure: 'timeout' },
  {
    name: 'strong',
    model: 'anthropic/claude-3.5-sonnet',
    timeoutMs: 15000,
    mockFailure: 'rate-limit',
  },
  { name: 'backup', model: 'google/gemini-2.0-flash-001', timeoutMs: 8000 },
]

/** 带状态码的错误，供 shouldTryNext 分类用 */
class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/**
 * 下面这一小段只在 MOCK=1 下用，是一个**演示级**的假模型。
 * 它靠关键词匹配来近似「模型读懂了 system prompt」这件事——
 * 真实模型靠的是提示词的语义约束，不是字符串包含，别把这段当生产做法。
 *
 * 它故意分成两支，为的是让你亲眼看到 system prompt 生效前后的差别：
 * - 提示词里**没有**声明能力边界（starter 的默认人设）：什么都热情作答，业务外的问题照样跑题。
 * - 提示词里**声明了**能力边界：订单域照答，业务外的礼貌拒答。
 */
const BOUNDARY_MARKERS = [
  '能力边界',
  '只回答',
  '不要尝试回答',
  // 英文版课程的读者会用英文写能力边界，这几条是等价标记
  'Scope',
  'only answer',
  'only handle',
]

const ORDER_KEYWORDS = [
  '订单',
  '下单',
  '下的单',
  '物流',
  '包裹',
  '收货',
  '快递',
  '发货',
  '送达',
  '退货',
  '退款',
  '换货',
  '售后',
  '发票',
  // 英文版课程的读者会用英文提问，这几条是等价关键词
  'order',
  'refund',
  'delivery',
  'shipping',
  'parcel',
  'invoice',
]

function looksLikeOrderQuestion(input: string): boolean {
  return ORDER_KEYWORDS.some((keyword) => input.includes(keyword))
}

function mockReply(systemPrompt: string, userInput: string): string {
  const hasBoundary = BOUNDARY_MARKERS.some((marker) => systemPrompt.includes(marker))
  const isOrderQuestion = looksLikeOrderQuestion(userInput)

  if (!hasBoundary) {
    // 没有能力边界的默认人设：有问必答，业务外的问题也照答不误
    return isOrderQuestion
      ? '这是离线模拟回复：您的订单预计明天送达。（提示词里还没有能力边界，这次恰好问的是业务内的问题）'
      : '这是离线模拟回复：好嘞——春风又绿江南岸，明月何时照我还。要不要我再写两句？（跑题了：system prompt 里还没写能力边界，默认人设有问必答）'
  }

  return isOrderQuestion
    ? '这是离线模拟回复：您的订单预计明天送达。去掉 MOCK=1 并配置 OPENROUTER_API_KEY 可连真模型。'
    : '这是离线模拟回复：抱歉，我只负责订单、退换货和物流相关的问题，别的帮不上忙。（能力边界生效）'
}

/**
 * 系统提示词：人设 + 能力边界 + 输出要求 + 动态上下文。
 * 最后一块每次请求现拼——模型没有时钟，不告诉它今天几号，它算不出「三天前下的单」。
 */
function buildSystemPrompt(now: Date): string {
  return [
    '你是「某电商平台」的售后助手。',
    '',
    '【能力边界】',
    '- 只回答订单、退换货、物流相关问题',
    '- 被问到无关问题时，礼貌说明你只负责售后，不要尝试回答',
    '',
    '【输出要求】',
    '- 每次回复不超过 3 句话，不使用 Markdown 标题和列表',
    '',
    '【当前上下文】',
    `- 现在时间：${now.toISOString().slice(0, 16).replace('T', ' ')}`,
  ].join('\n')
}

/** 调用单个 provider。失败时抛 ProviderError，由上层决定要不要换下一家。 */
async function callOne(provider: Provider, userInput: string): Promise<Reply> {
  const systemPrompt = buildSystemPrompt(new Date())
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInput },
  ]

  if (process.env.MOCK === '1') {
    if (provider.mockFailure === 'timeout') {
      throw new ProviderError(`${provider.name} 超时（模拟）`, 408)
    }
    if (provider.mockFailure === 'rate-limit') {
      throw new ProviderError(`${provider.name} 被限流（模拟）`, 429)
    }
    if (provider.mockFailure === 'bad-request') {
      throw new ProviderError(`${provider.name} 请求体不合法（模拟）`, 400)
    }
    return {
      // 假模型的回答跟着 system prompt 走——没写能力边界就跑题，写了才拒答
      text: mockReply(systemPrompt, userInput),
      provider: provider.name,
      tokens: 128,
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages }),
    signal: AbortSignal.timeout(provider.timeoutMs),
  })
  if (!res.ok) throw new ProviderError(`${provider.name} 返回 HTTP ${res.status}`, res.status)

  const json = (await res.json()) as {
    choices: { message: { content: string } }[]
    usage: { total_tokens: number }
  }
  return {
    text: json.choices[0].message.content,
    provider: provider.name,
    tokens: json.usage.total_tokens,
  }
}

/**
 * 该不该换下一家。这是 fallback 的第一步，不是重试。
 * 判断依据不是状态码本身，而是「换一家有没有可能变好」：
 * - 408 超时 / 429 限流 / 5xx 服务端故障：对方的问题，换一家大概率能成。
 * - 402 余额不足 / 404 模型被下线或改名：也是「这一家不行」，换一家能救回来，最容易被漏掉。
 * - 400 请求体不合法 / 403 被安全策略拦截：你自己的问题，换谁都一样，重试只是白烧钱。
 * - 401 看凭证怎么管：三家共用一把 key 时换了还是错；各家各有各的 key 时应当继续。
 *   本实验三家共用一个 OpenRouter key，所以留在「不换」这一类。
 */
const RETRIABLE_STATUS = new Set([402, 404, 408, 429])

function shouldTryNext(err: unknown): boolean {
  if (err instanceof ProviderError) {
    // 读结构化的 status 字段，不要去解析 err.message —— 错误文案一改逻辑就崩
    return RETRIABLE_STATUS.has(err.status) || err.status >= 500
  }
  // AbortSignal.timeout 抛的是 TimeoutError
  return err instanceof Error && err.name === 'TimeoutError'
}

async function callModel(userInput: string): Promise<Reply> {
  const errors: string[] = []
  for (const provider of PROVIDERS) {
    try {
      const reply = await callOne(provider, userInput)
      if (errors.length > 0) console.log(`[降级路径] ${errors.join(' → ')} → ${provider.name} 成功`)
      return reply
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(message)
      if (!shouldTryNext(err)) {
        console.log(`[不重试] ${message}——这是请求本身的问题，换 provider 也一样`)
        throw err
      }
      console.log(`[降级] ${message}，尝试下一个 provider`)
    }
  }
  throw new Error(`所有 provider 都失败了：${errors.join('; ')}`)
}

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ') || '我三天前下的单什么时候到？'
  console.log(`你> ${question}`)
  const reply = await callModel(question)
  console.log(`助教> ${reply.text}`)
  console.log(`[usage] provider=${reply.provider} tokens=${reply.tokens}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
