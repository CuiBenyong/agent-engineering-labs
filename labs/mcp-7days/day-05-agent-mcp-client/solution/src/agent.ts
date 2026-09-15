// Agent 循环。MCP 只负责「工具从哪来、怎么调」，循环本身还是 30 天课里那一套：
// 模型说要调工具 -> 我们调 -> 把结果作为一条消息塞回去 -> 再问一次模型。
import { resultText, type JsonValue } from './protocol.js'
import type { ModelTool, ToolRegistry } from './registry.js'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, JsonValue>
}

export interface ModelTurn {
  text?: string
  toolCalls: ToolCall[]
}

export interface ChatModel {
  next(messages: Message[], tools: ModelTool[]): Promise<ModelTurn>
}

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface LoopResult {
  answer: string
  /** 这一轮实际调过的工具名，按顺序。自测和排查都靠它。 */
  used: string[]
  steps: number
}

/**
 * 一次工具调用在循环里占两步：模型的一次输出，加我们回填结果之后的又一次输入。
 * maxSteps 是硬闸——模型完全可能在两个工具之间来回跳，没有闸就是死循环加账单。
 */
export async function runLoop(
  model: ChatModel,
  registry: ToolRegistry,
  question: string,
  maxSteps = 6
): Promise<LoopResult> {
  const messages: Message[] = [{ role: 'user', content: question }]
  const used: string[] = []
  const tools = registry.modelTools()

  for (let step = 1; step <= maxSteps; step++) {
    const turn = await model.next(messages, tools)
    if (turn.toolCalls.length === 0) {
      return { answer: turn.text ?? '', used, steps: step }
    }
    messages.push({ role: 'assistant', content: turn.text ?? '', toolCalls: turn.toolCalls })
    for (const call of turn.toolCalls) {
      used.push(call.name)
      // call 永远不抛：失败也是一条 isError 的工具结果，模型看得见就有机会改。
      const result = await registry.call(call.name, call.arguments)
      const prefix = result.isError ? '[工具报错] ' : ''
      messages.push({ role: 'tool', toolCallId: call.id, content: prefix + resultText(result) })
    }
  }
  return { answer: '（超过最大步数仍未收敛）', used, steps: maxSteps }
}

/**
 * 离线模型：MOCK=1 时用它，不联网、结果确定。
 * 规则很笨：按问题里的关键词挑一个工具，拿到结果就把结果当答案。
 * 它存在的意义是让你能在没有 key 的情况下把整条链路跑通。
 */
export class MockModel implements ChatModel {
  private calls = 0

  async next(messages: Message[], tools: ModelTool[]): Promise<ModelTurn> {
    const last = messages[messages.length - 1]
    if (last?.role === 'tool') {
      return { text: `根据工具返回：\n${last.content}`, toolCalls: [] }
    }
    const question = messages.find((m) => m.role === 'user')?.content ?? ''
    const pick = this.choose(question, tools)
    if (!pick) return { text: '没有合适的工具，我直接回答：不知道。', toolCalls: [] }
    this.calls += 1
    return {
      text: '',
      toolCalls: [
        { id: `call_${this.calls}`, name: pick.name, arguments: this.argsFor(pick, question) },
      ],
    }
  }

  /** 只看名字与描述里的关键词。真模型看的也是这两样，只是聪明得多。 */
  private choose(question: string, tools: ModelTool[]): ModelTool | undefined {
    const wantTicket = /工单|ticket|T-\d+/i.test(question)
    const wantNote = /笔记|note|文档/.test(question)
    const scored = tools
      .map((tool) => {
        let score = 0
        if (wantTicket && /tickets/.test(tool.name)) score += 2
        if (wantNote && /notes/.test(tool.name)) score += 2
        if (/search/.test(tool.name)) score += 1
        return { tool, score }
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
    return scored[0]?.tool
  }

  private argsFor(tool: ModelTool, question: string): Record<string, JsonValue> {
    const properties = (tool.input_schema.properties ?? {}) as Record<string, JsonValue>
    if ('query' in properties) {
      const keyword = /分页/.test(question)
        ? '分页'
        : /开着|open/.test(question)
          ? 'open'
          : question.slice(0, 4)
      return { query: keyword }
    }
    if ('slug' in properties) return { slug: 'pagination' }
    if ('id' in properties) return { id: 'T-1001' }
    return {}
  }
}

interface OpenRouterToolCall {
  id: string
  function: { name: string; arguments: string }
}

/** 真模型：走 OpenRouter 的 OpenAI 兼容接口。没有 key 就别用它，用 MockModel。 */
export class OpenRouterModel implements ChatModel {
  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async next(messages: Message[], tools: ModelTool[]): Promise<ModelTurn> {
    const body = {
      model: this.model,
      messages: messages.map((m) => {
        if (m.role === 'tool')
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })),
          }
        }
        return { role: m.role, content: m.content }
      }),
      // 这里是整个客户端唯一一处「MCP 的形状」变成「模型 API 的形状」的地方。
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    }
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`模型接口返回 ${res.status}：${await res.text()}`)
    const data = (await res.json()) as {
      choices: { message: { content?: string; tool_calls?: OpenRouterToolCall[] } }[]
    }
    const message = data.choices[0]?.message ?? {}
    const toolCalls = (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: safeParse(call.function.arguments),
    }))
    return { text: message.content ?? '', toolCalls }
  }
}

function safeParse(raw: string): Record<string, JsonValue> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, JsonValue>
    }
  } catch {
    // 模型偶尔会吐出半截 JSON。这里不抛，让工具那边报参数错误，模型自己改。
  }
  return {}
}
