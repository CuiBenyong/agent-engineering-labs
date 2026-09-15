import 'dotenv/config'

/** 一个模型 provider 的配置。 */
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

// 现在只有一个 provider 且不会失败，所以 `MOCK=1 pnpm start` 直接就能跑通——
// 先跑一次看看「正常路径」长什么样，再往下做练习。
//
// 练习 1：把三个 provider 配齐，注意超时值要按 provider 分别设——
// 强模型本来就慢，给它和快模型一样的超时会把本可成功的请求掐死。
const PROVIDERS: Provider[] = [
  { name: 'fast', model: 'openai/gpt-4o-mini', timeoutMs: 8000 },
  // TODO: 补上 strong（anthropic/claude-3.5-sonnet，超时给足 15 秒，mockFailure 设为 'rate-limit'）
  // TODO: 补上 backup（google/gemini-2.0-flash-001，8 秒，不设 mockFailure —— 它是兜底的那个）
  // 提示：mockFailure 还有第三个取值 'bad-request'（模拟 400），验收标准第 2 条会用到。
  // TODO: 三个都配好之后，再给上面的 fast 加上 mockFailure: 'timeout'，
  //       这样 MOCK=1 下就能走出「超时 → 429 → 成功」的完整降级链路。
]

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
 * 练习 2：写出你自己的 system prompt。
 * 结构建议：人设 + 能力边界 + 输出要求 + 动态上下文。
 * 提示：把「现在时间」拼进去——模型没有时钟，不告诉它今天几号，
 * 它算不出「三天前下的单」是哪天。
 */
function buildSystemPrompt(now: Date): string {
  // 做这题之前，先原样跑一次 `MOCK=1 pnpm start 帮我写首诗`：
  // 你会看到它兴致勃勃地给你写诗——这就是下面这句敷衍的默认人设造成的，
  // 它正是正文点名批评的那种框架默认值：不知道你的业务边界、不约束输出格式、
  // 还可能在下次升级后悄悄变掉。**记住这个跑题的输出，它是对比的前半段。**
  //
  // TODO: 把它替换成一段真正约束住模型的提示词（人设 + 能力边界 + 输出要求 + 当前时间）。
  // 写完再跑一次同一条命令，看它是否改口礼貌拒答——**从跑题变成拒答**，
  // 这个变化才是 system prompt 生效的证据。去掉 MOCK=1 连真模型，结论应当一致。
  void now
  return '你是一个乐于助人的 AI 助手。'
}

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
 * 练习 3：决定这个错误该不该换下一家。
 * 判断依据不是状态码本身，而是一句话：**换一家有没有可能变好**。
 * - 换了也没用：400 请求体不合法、403 内容被安全策略拦截——你自己的请求有问题，
 *   重试只是把同一个 bug 再犯一遍，白花两倍的时间和钱。
 * - 换了有可能好：408 超时、429 限流、5xx 服务端故障，
 *   还有两个容易被漏掉的——402 余额不足、404 模型被下线或改名。
 * - 401 看情况：三家共用同一把 key 时换了还是错；三家各有各的 key 时应当继续。
 *   本实验三家共用一个 OpenRouter key，所以归进「不换」那一类。
 */
function shouldTryNext(err: unknown): boolean {
  // TODO: 按上面的分类返回 true / false。
  // 提示：ProviderError 上有 status 字段，直接读字段就行——
  //       千万别去解析 err.message 字符串，错误文案一改你的逻辑就崩。
  //       另外 AbortSignal.timeout 抛的错 name 是 'TimeoutError'。
  void err
  return false
}

async function callModel(userInput: string): Promise<Reply> {
  const errors: string[] = []
  for (const provider of PROVIDERS) {
    try {
      const reply = await callOne(provider, userInput)
      // 练习 4：把降级路径打出来，让你能一眼看到「超时 → 429 → 成功」的完整链路。
      // TODO: 如果 errors 非空，打印一行 [降级路径]，把走过的失败依次串起来。
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
