// 唯一的网络出口。MOCK=1 时真实请求一行都不执行，
// 但假数据必须**随输入变化**——路由是本章的正题，返回一段固定 JSON 你就什么都看不到了。

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

function model(): string {
  return process.env.MODEL ?? 'openai/gpt-4o-mini'
}

async function chat(body: Record<string, unknown>): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model(), ...body }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`)

  const parsed = (await res.json()) as { choices: { message: { content: string } }[] }
  return parsed.choices[0]?.message?.content ?? ''
}

const ROUTER_SYSTEM =
  '你是电商客服的分诊台。只判断这一单该交给谁，不要自己回答用户的问题，也不要编造订单信息。'

// ---------------------------------------------------------------------------
// 出口一：结构化输出的路由决策。
// 注意返回类型是 unknown——模型给的永远只是一段 JSON 文本，
// 「它符合我的 schema」这件事必须由调用方校验，不能由类型标注凭空承诺。
// ---------------------------------------------------------------------------

export async function routeStructured(text: string, jsonSchema: unknown): Promise<unknown> {
  if (process.env.MOCK === '1') {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return offlineDecision(text)
  }

  const content = await chat({
    messages: [
      { role: 'system', content: ROUTER_SYSTEM },
      { role: 'user', content: text },
    ],
    // 服务端按 schema 约束解码，模型没法「顺口」多说一句话。
    // 即便如此，回来的仍然是文本，仍然要 JSON.parse + zod 校验：不是所有网关都严格执行。
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'route_decision', strict: true, schema: jsonSchema },
    },
  })

  try {
    return JSON.parse(content) as unknown
  } catch {
    // 解析失败也要交回上层，由 normalizeDecision 统一落 fallback，不要在这里私自兜底
    return { raw: content }
  }
}

/**
 * 离线路由决策：按关键词生成**不同**的判断，覆盖本章要演示的四种现象。
 * 真实模型的输出当然没这么整齐，但这四类现象每一类都是线上真实发生过的。
 */
function offlineDecision(text: string): unknown {
  if (/退款|退货|退钱/.test(text)) {
    return {
      route: 'refund_draft',
      confidence: 0.92,
      routingReason: '用户明确提出退款诉求，需要按规则拟一份退款方案',
    }
  }
  if (/物流|快递|发货|到哪|订单/.test(text)) {
    return {
      route: 'order_lookup',
      confidence: 0.88,
      routingReason: '用户在问某一单的状态或物流进度，属于订单查询',
    }
  }
  if (/投诉|差评|举报/.test(text)) {
    // 模型自造了一个不存在的部门——这不是编的，是真实模型在枚举提示不够强时的常见行为
    return {
      route: 'complaint_handler',
      confidence: 0.95,
      routingReason: '用户在投诉，应该转给投诉处理专员',
    }
  }
  if (/你好|在吗|谢谢|辛苦/.test(text)) {
    return { route: 'smalltalk', confidence: 0.9, routingReason: '寒暄，没有具体业务诉求' }
  }
  // 模糊输入：模型给了一个路由，但自己也没把握。这一条专门用来演示置信度阈值
  return {
    route: 'order_lookup',
    confidence: 0.42,
    routingReason: '用户提到「那个事」但没说是哪一单，只能猜是订单相关',
  }
}

// ---------------------------------------------------------------------------
// 出口二（对照组）：让模型用自然语言回答「该找谁」。
// 本章要批判的就是它，所以它必须真的存在、真的能跑，读者才看得到失败现场。
// ---------------------------------------------------------------------------

export async function routeFreeText(text: string): Promise<string> {
  if (process.env.MOCK === '1') {
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (/退款|退货|退钱/.test(text)) return '这个应该走退款流程，我建议转给负责退款方案的同事。'
    if (/物流|快递|发货|到哪|订单/.test(text)) return '我觉得这个可以让查订单的同事看一下。'
    if (/投诉|差评|举报/.test(text)) return '这位客户情绪比较激动，先安抚一下比较好。'
    return '嗯，我看看啊，这个不太好说。'
  }

  return chat({
    messages: [
      { role: 'system', content: `${ROUTER_SYSTEM} 用一句话说明该找谁。` },
      { role: 'user', content: text },
    ],
  })
}

// ---------------------------------------------------------------------------
// 出口三：子 Agent 真正回答用户。三个子 Agent 共用这一个出口，人设由 system 决定。
// ---------------------------------------------------------------------------

export async function callSubAgent(
  system: string,
  text: string,
  orderId?: string
): Promise<string> {
  if (process.env.MOCK === '1') {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return offlineAnswer(system, text, orderId)
  }

  return chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: orderId ? `${text}（订单号 ${orderId}）` : text },
    ],
  })
}

function offlineAnswer(system: string, text: string, orderId?: string): string {
  const tail = orderId ? `订单 ${orderId} ` : '这笔订单 '
  if (system.includes('物流')) {
    return `${tail}已发出，当前在转运中心，预计明天送达。（离线模拟）`
  }
  if (system.includes('退款')) {
    return `${tail}符合七天无理由，可退金额以实付为准，方案已拟好待人工复核，本节点不执行退款。（离线模拟）`
  }
  return `收到，${text.slice(0, 12)}…这边先帮你记下了，需要查单或退款随时说。（离线模拟）`
}
