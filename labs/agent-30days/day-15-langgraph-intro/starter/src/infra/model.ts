// 唯一的网络出口。MOCK=1 时整段真实请求一行都不执行，
// 但假回复必须**随输入变化**——否则你在离线状态下看到的不是本章的现象，是一段固定文案。

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export interface ModelReply {
  text: string
  /** 这一次调用花掉的 token 估算，按 D6 定的 1 字符 ≈ 1 token 保守高估 */
  tokens: number
}

/** 离线回复：按用户这句话里的关键词生成不同结果，并把抽到的订单号带回来。 */
function offlineReply(prompt: string, orderId?: string): string {
  const tail = orderId ? `订单 ${orderId} ` : '这笔订单 '
  if (/退款|退货|退钱/.test(prompt)) {
    return `${tail}符合七天无理由，可退金额以实付为准，退款方案已拟好待复核。（离线模拟）`
  }
  if (/物流|快递|到哪|发货/.test(prompt)) {
    return `${tail}已发出，当前在转运中心，预计明天送达。（离线模拟）`
  }
  if (/发票|开票/.test(prompt)) {
    return `${tail}可开电子普通发票，提交后 24 小时内发到你的邮箱。（离线模拟）`
  }
  return `${tail}状态正常，还有别的可以帮你的吗？（离线模拟）`
}

/**
 * 调一次模型。这是本 lab 唯一一处会走网络的地方，
 * 所以 MOCK 的判断放在函数最前面，真实分支在离线时完全不会被执行。
 */
export async function callModel(
  system: string,
  prompt: string,
  orderId?: string
): Promise<ModelReply> {
  if (process.env.MOCK === '1') {
    const text = offlineReply(prompt, orderId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { text, tokens: system.length + prompt.length + text.length }
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: orderId ? `${prompt}（订单号 ${orderId}）` : prompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`)

  const body = (await res.json()) as {
    choices: { message: { content: string } }[]
    usage?: { total_tokens?: number }
  }
  const text = body.choices[0]?.message?.content ?? ''
  return { text, tokens: body.usage?.total_tokens ?? system.length + prompt.length + text.length }
}
