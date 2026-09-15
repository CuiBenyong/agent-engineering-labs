// 唯一的网络出口。MOCK=1 时在函数最前面短路，真实分支一行都不执行。
// 注意：MCP server 不在这里——它是本地子进程，MOCK 下照样真的跑。
import type { FunctionTool } from './bridge'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** role 为 tool 时，这条结果是哪个工具产生的 */
  toolName?: string
}

export interface ModelReply {
  /** 模型决定收尾时给出的自然语言回答 */
  text?: string
  /** 模型决定调工具时给出的调用意图 */
  toolCall?: { name: string; args: Record<string, unknown> }
}

const ORDER_ID = /SO\d{8}/g

/** 从一段文本里取最后一个订单号：报错文案里的示例订单号总是排在用户那个错的后面。 */
function lastOrderId(text: string): string | undefined {
  const found = text.match(ORDER_ID)
  return found?.[found.length - 1]
}

/**
 * 离线假模型。它不是「一律返回成功」的死桩，而是**真的读你传进去的 tools**：
 * 工具少一个它就选不出来，参数 schema 是空的它就填不出参数，
 * 所以练习没做完时你会看到真实的失败现象，而不是一片虚假的绿。
 */
function mockComplete(messages: ChatMessage[], tools: FunctionTool[]): ModelReply {
  const question = messages.find((m) => m.role === 'user')?.content ?? ''
  const toolMessages = messages.filter((m) => m.role === 'tool')
  const last = toolMessages[toolMessages.length - 1]
  const failures = toolMessages.filter((m) => m.content.startsWith('[工具报错]')).length

  if (last && !last.content.startsWith('[工具报错]')) {
    return { text: `根据 ${last.toolName} 通过 MCP 返回的结果：${last.content}` }
  }
  if (failures >= 2) {
    return { text: '连续两次都没查到，建议让用户核对订单号后再试。' }
  }

  // 选工具：按关键词粗分诊。工具没被 server 暴露出来，这里就选不到。
  const wantsShipment = /物流|快递|到哪|发货|轨迹/.test(question)
  const wanted = wantsShipment ? 'track_shipment' : 'query_order'
  const tool = tools.find((t) => t.function.name === wanted)
  if (!tool) {
    return { text: `我这边没有 ${wanted} 这个工具，查不了，建议转人工。` }
  }

  // 填参数：只照着 schema 里真实存在的字段填。schema 是空的（翻译那一步没做），
  // 这里就只能交一个空对象上去——然后被 server 的参数校验挡回来。
  const args: Record<string, unknown> = {}
  const source = last?.content.startsWith('[工具报错]') ? last.content : question
  for (const field of Object.keys(tool.function.parameters.properties)) {
    if (field.includes('order')) {
      const id = lastOrderId(source) ?? lastOrderId(question)
      if (id) args[field] = id
    }
  }
  return { toolCall: { name: tool.function.name, args } }
}

export async function complete(
  messages: ChatMessage[],
  tools: FunctionTool[]
): Promise<ModelReply> {
  if (process.env.MOCK === '1') return mockComplete(messages, tools)

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages: messages.map((m) =>
        m.role === 'tool'
          ? { role: 'user', content: `[工具 ${m.toolName} 的返回]\n${m.content}` }
          : { role: m.role, content: m.content }
      ),
      // 这一行就是全天的立论点：MCP server 列出的工具，最终仍然以 function calling 的形状发给模型
      tools,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`模型返回 HTTP ${res.status}`)

  const json = (await res.json()) as {
    choices: {
      message: {
        content?: string
        tool_calls?: { function: { name: string; arguments: string } }[]
      }
    }[]
  }
  const message = json.choices[0].message
  const call = message.tool_calls?.[0]
  if (call) {
    return {
      toolCall: {
        name: call.function.name,
        args: JSON.parse(call.function.arguments) as Record<string, unknown>,
      },
    }
  }
  return { text: message.content ?? '' }
}
