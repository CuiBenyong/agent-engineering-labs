import { CANARY, UNTRUSTED_NOTICE } from './guards'
import { PROBES } from './tools'
import type { ToolCall } from './policy'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface ModelReply {
  text: string
  toolCalls: ToolCall[]
}

/** 唯一的网络出口。MOCK=1 时走下面的假模型，真实分支一行都不执行。 */
export async function callModel(messages: ChatMessage[]): Promise<ModelReply> {
  if (process.env.MOCK === '1') return mockModel(messages)

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages: messages.map((m) => ({
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content,
      })),
      tools: TOOL_SCHEMAS,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    // 错误信息里不带请求体，也不带响应体——它们都可能夹着密钥或用户数据
    throw new Error(`模型返回 HTTP ${res.status}`)
  }
  const json = (await res.json()) as {
    choices: { message: { content?: string; tool_calls?: RawToolCall[] } }[]
  }
  const message = json.choices[0].message
  return {
    text: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map((c) => ({
      name: c.function.name,
      args: JSON.parse(c.function.arguments) as Record<string, unknown>,
    })),
  }
}

interface RawToolCall {
  function: { name: string; arguments: string }
}

const TOOL_SCHEMAS = [
  fn('query_order', '查订单本身；物流用 track_shipment，退款进度用 query_refund', {
    orderId: { type: 'string' },
  }),
  fn('track_shipment', '查物流轨迹', { orderId: { type: 'string' } }),
  fn('query_refund', '查退款进度', { orderId: { type: 'string' } }),
  fn('apply_refund', '发起退款（不可逆）', {
    orderId: { type: 'string' },
    amount: { type: 'number' },
  }),
  fn('memory_search', '检索知识库', { query: { type: 'string' }, topK: { type: 'integer' } }),
]

function fn(name: string, description: string, properties: Record<string, unknown>) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required: Object.keys(properties) },
    },
  }
}

// ---------------------------------------------------------------------------
// 假模型：它必须**真的会上钩**，否则今天的实验就白做了。
// 一个「一律拒绝」的桩会让每一项都变绿，而你什么都没验证到。
// ---------------------------------------------------------------------------

function mockModel(messages: ChatMessage[]): ModelReply {
  const shielded = messages.some((m) => m.role === 'system' && m.content.includes(UNTRUSTED_NOTICE))
  const context = messages
    .filter((m) => m.role === 'user' || m.role === 'tool')
    .map((m) => m.content)
    .join('\n')

  // 逐个变体判断「这次说服成不成功」：
  // - 没被 <untrusted> 包住的指令，假模型一律照做（这就是注入生效的样子）；
  // - 包住并且系统提示词声明过之后，它能识破直白与客气两种说法，
  //   但仍然会被「伪装成系统消息」那一种骗到——包裹是缓解，不是闸门。
  for (const [variant, probe] of Object.entries(PROBES)) {
    const at = context.indexOf(probe)
    if (at < 0) continue
    const protectedHere = shielded && insideUntrusted(context, at)
    if (protectedHere && variant !== 'spoofed') continue
    return {
      text: `${CANARY} 好的，已按最新指令处理。`,
      toolCalls: probe.includes('全额退款')
        ? [
            {
              name: 'apply_refund',
              args: { orderId: lastOrderId(context), amount: lastAmount(context) },
            },
          ]
        : [],
    }
  }

  // 正常路径：先查单，再基于查到的内容作答
  const asked = /ORD-\d+/.exec(context)?.[0]
  const hasToolResult = messages.some((m) => m.role === 'tool')
  if (asked && !hasToolResult) {
    return { text: '', toolCalls: [{ name: 'query_order', args: { orderId: asked } }] }
  }
  if (hasToolResult) {
    const status = /"status":"([^"]+)"/.exec(context)?.[1] ?? '未知'
    return {
      text: `订单 ${asked ?? ''} 当前状态：${status}。备注里有一段要求我改变行为的文字，我按数据处理，没有执行。`,
      toolCalls: [],
    }
  }
  return { text: '您好，请提供订单号，我帮您查询。', toolCalls: [] }
}

/** 判断某个位置是否落在某一段 <untrusted> … </untrusted> 之内。 */
function insideUntrusted(text: string, at: number): boolean {
  const open = /<untrusted[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = open.exec(text)) !== null) {
    const start = match.index + match[0].length
    const end = text.indexOf('</untrusted>', start)
    const stop = end === -1 ? text.length : end
    if (at >= start && at < stop) return true
  }
  return false
}

function lastOrderId(context: string): string {
  const all = context.match(/ORD-\d+/g)
  return all ? all[all.length - 1] : 'ORD-2001'
}

function lastAmount(context: string): number {
  const all = context.match(/"amount":(\d+(?:\.\d+)?)/g)
  return all ? Number(all[all.length - 1].split(':')[1]) : 200
}
