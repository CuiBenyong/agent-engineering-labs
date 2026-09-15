/**
 * pi-lite —— Pi SDK 公开 API 的最小复刻，四百行出头，近四分之一是注释，可以完整读完。
 *
 * 为什么不直接装真 SDK：真 SDK 需要一份本地模型配置和一把真 key 才能跑，
 * 而本课要求实验在完全离线（MOCK=1）的情况下也能看到正确现象。所以这里按
 * Pi 公开接口的**形状**复刻了一份最小内核 —— 名字、参数、事件名都对齐，
 * 换成真 SDK 只要改一行 import（见 README 的「换成真 Pi SDK」一节）。
 *
 * 你要做的事：把这个文件当成正文那张对照表的答案，逐格找到
 * 「D2 你亲手写的哪一行，现在住在这里的哪个函数里」。
 */

// ─────────────────────────── 工具（Tool） ───────────────────────────

export interface TextPart {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: TextPart[]
  details?: Record<string, unknown>
}

/** 极简版 JSON Schema：够描述本课的工具参数，也够内核做校验。 */
export interface FieldSchema {
  type: 'string' | 'number'
  /** 这段描述同样是写给模型看的，它决定模型往这个字段里填什么 */
  description: string
}

export interface ObjectSchema {
  type: 'object'
  properties: Record<string, FieldSchema>
  required: string[]
}

export interface AgentTool {
  name: string
  /** 只给界面展示用，模型看不到 */
  label: string
  /** 写给模型看的说明书：它靠这段话决定要不要调、什么时候调 */
  description: string
  parameters: ObjectSchema
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>
}

/**
 * 注册工具的入口。泛型 P 让你在 execute 里拿到结构化参数，
 * 而不是自己 JSON.parse 之后一路 as 下去 —— 这正是 D2 手写版里最烦人的一段。
 */
export function defineTool<P extends Record<string, unknown>>(spec: {
  name: string
  label: string
  description: string
  parameters: ObjectSchema
  execute: (toolCallId: string, params: P) => Promise<ToolResult>
}): AgentTool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    // 参数已经在内核里按 schema 校验过，这里做唯一一次断言，调用方拿到的就是 P
    execute: (toolCallId, params) => spec.execute(toolCallId, params as P),
  }
}

/** 便捷构造：绝大多数工具只需要返回一段文本 */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: {} }
}

// ─────────────────────────── 消息与事件 ───────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface AgentMessage {
  role: Role
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  isError?: boolean
}

/** 与 Pi 的 stopReason 取值一一对应；maxTurns 是本内核自己加的兜底 */
export type StopReason = 'stop' | 'toolUse' | 'length' | 'error' | 'aborted' | 'maxTurns'

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'turn_start'; turn: number }
  | { type: 'message_start'; role: Role }
  | { type: 'message_update'; delta: string }
  | { type: 'message_end'; text: string }
  | { type: 'tool_execution_start'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean; text: string }
  | { type: 'turn_end'; turn: number; toolResults: number }
  | { type: 'agent_end'; stopReason: StopReason }

// ─────────────────────────── 模型层 ───────────────────────────

export interface Model {
  provider: string
  id: string
}

/** 对应 Pi 的模型调用层：负责「有哪些模型能用」，以及真正把请求发出去 */
export class ModelRuntime {
  private constructor(private readonly models: Model[]) {}

  static async create(): Promise<ModelRuntime> {
    if (process.env.MOCK === '1') {
      return new ModelRuntime([{ provider: 'mock', id: 'offline-mock' }])
    }
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')
    }
    return new ModelRuntime([
      { provider: 'openrouter', id: process.env.MODEL ?? 'openai/gpt-4o-mini' },
    ])
  }

  async getAvailable(): Promise<Model[]> {
    return this.models
  }
}

/** 会话存储。本课只做内存版；真 SDK 里还有落盘、分叉、恢复等实现 */
export class SessionManager {
  private constructor(readonly messages: AgentMessage[]) {}

  static inMemory(): SessionManager {
    return new SessionManager([])
  }
}

// ─────────────────────────── 唯一的网络出口 ───────────────────────────

interface ModelReply {
  text: string
  toolCalls: ToolCall[]
  stopReason: StopReason
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 整个内核只有这一个函数会碰网络，所以 MOCK 的桩也只打在这里。
 * 循环、分派、校验、回填那些业务逻辑在 MOCK 下照样真实执行。
 */
async function callModel(
  model: Model,
  messages: AgentMessage[],
  tools: AgentTool[],
  onDelta: (delta: string) => void
): Promise<ModelReply> {
  if (process.env.MOCK === '1') return mockCall(messages, tools, onDelta)

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model.id,
      messages: messages.map(toWireMessage),
      tools: tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    }),
  })
  if (!res.ok) throw new Error(`模型返回 HTTP ${res.status}`)

  const json = (await res.json()) as {
    choices: {
      finish_reason: string
      message: {
        content: string | null
        tool_calls?: { id: string; function: { name: string; arguments: string } }[]
      }
    }[]
  }
  const choice = json.choices[0]
  const text = choice.message.content ?? ''
  if (text) onDelta(text) // D1 已经手写过 SSE 解析，这里为了让内核保持可读，真实分支走非流式

  const toolCalls = (choice.message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    // 这一步 D2 是你自己写的；现在归内核，解析失败也由内核变成一次工具错误
    args: JSON.parse(call.function.arguments || '{}') as Record<string, unknown>,
  }))
  return {
    text,
    toolCalls,
    stopReason: choice.finish_reason === 'tool_calls' ? 'toolUse' : 'stop',
  }
}

/** 把内部消息翻译成 OpenAI 兼容的线上格式 */
function toWireMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

/**
 * 离线假模型：给出的现象跟真模型同构 —— 第一轮请求调工具，第二轮根据工具结果作答。
 * 它按「注册了哪些工具」决定这一轮请求调什么，所以你少注册一个工具，
 * 立刻就能在输出里看到差别。
 */
async function mockCall(
  messages: AgentMessage[],
  tools: AgentTool[],
  onDelta: (delta: string) => void
): Promise<ModelReply> {
  const names = new Set(tools.map((tool) => tool.name))
  const toolResults = messages.filter((message) => message.role === 'tool')

  // 假模型也会「读说明书」：描述太含糊的工具，它判断不出该不该用，于是不调。
  // 这不是真实模型的做法（真模型靠语义理解），但能让你离线看到「描述是写给模型看的」这个事实。
  const calc = tools.find((tool) => tool.name === 'calc')
  const calcIsUsable = calc !== undefined && calc.description.length >= 20

  if (toolResults.length === 0) {
    const planned: ToolCall[] = []
    if (names.has('get_time')) planned.push({ id: 'call_1', name: 'get_time', args: {} })
    if (calcIsUsable) {
      // 加 --tool-error 参数会让模型填一个非法表达式，用来演示「工具报错怎么回传」
      const expression = process.argv.includes('--tool-error') ? '12 ÷ 0' : '(12 + 30) * 2'
      planned.push({ id: 'call_2', name: 'calc', args: { expression } })
    }
    if (planned.length > 0) return { text: '', toolCalls: planned, stopReason: 'toolUse' }
  }

  const failed = toolResults.filter((message) => message.isError)
  let text: string
  if (failed.length > 0) {
    text = `这是离线模拟回复：刚才那次工具调用失败了（${failed[0].content}），我不硬猜结果，换个说法——请把表达式改成只含数字和加减乘除的形式再问我一次。`
  } else if (toolResults.length === 0) {
    text = '这是离线模拟回复：我手上一个工具都没有，只能凭空回答，帮不上什么忙。'
  } else {
    const facts = toolResults.map((message) => message.content).join('；')
    let missing = ''
    if (calc === undefined) missing = '（我手上没有计算工具，所以那道算术没法算）'
    else if (!calcIsUsable) missing = '（有个 calc 工具，但它的描述太含糊，我判断不出该不该用它）'
    text = `这是离线模拟回复：${facts}。${missing}去掉 MOCK=1 并在 .env 里配置 OPENROUTER_API_KEY，就能连上真模型。`
  }

  for (const char of text) {
    await sleep(8)
    onDelta(char)
  }
  return { text, toolCalls: [], stopReason: 'stop' }
}

// ─────────────────────────── Agent 循环（内核层） ───────────────────────────

export interface CreateAgentSessionOptions {
  model: Model
  modelRuntime: ModelRuntime
  customTools?: AgentTool[]
  sessionManager?: SessionManager
  systemPrompt?: string
  /** 内核自己的轮次上限，对应 turn_start/turn_end 事件；概念上和 D2 手写版的 MAX_STEPS（那边是 6）
   * 是同一类刹车，但不是同一个数——这里是框架层的默认值，两处各自决定要设多少 */
  maxTurns?: number
}

export class AgentSession {
  private readonly listeners = new Set<(event: AgentEvent) => void>()

  constructor(
    private readonly model: Model,
    private readonly tools: AgentTool[],
    private readonly messages: AgentMessage[],
    private readonly maxTurns: number
  ) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /**
   * 这就是 D2 那个 while 循环。它现在住在内核里，
   * 外面只看得到一句 await session.prompt(...)。
   */
  async prompt(text: string): Promise<void> {
    this.emit({ type: 'agent_start' })
    this.messages.push({ role: 'user', content: text })

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      this.emit({ type: 'turn_start', turn })
      this.emit({ type: 'message_start', role: 'assistant' })

      const reply = await callModel(this.model, this.messages, this.tools, (delta) =>
        this.emit({ type: 'message_update', delta })
      )
      this.emit({ type: 'message_end', text: reply.text })
      this.messages.push({
        role: 'assistant',
        content: reply.text,
        toolCalls: reply.toolCalls,
      })

      // D2 留下的锚点：停止原因不是「要调工具」，这一轮就是最后一轮
      if (reply.stopReason !== 'toolUse') {
        this.emit({ type: 'turn_end', turn, toolResults: 0 })
        this.emit({ type: 'agent_end', stopReason: reply.stopReason })
        return
      }

      for (const call of reply.toolCalls) {
        await this.runTool(call)
      }
      this.emit({ type: 'turn_end', turn, toolResults: reply.toolCalls.length })
    }

    this.emit({ type: 'agent_end', stopReason: 'maxTurns' })
    throw new Error(`超过最大轮数 ${this.maxTurns}，可能陷入死循环`)
  }

  /** 分派 + 校验 + 执行 + 回填：D2 里那一大段 for 循环，现在归内核 */
  private async runTool(call: ToolCall): Promise<void> {
    this.emit({ type: 'tool_execution_start', toolName: call.name, args: call.args })
    const tool = this.tools.find((candidate) => candidate.name === call.name)

    let text: string
    let isError = false
    try {
      if (!tool) throw new Error(`没有注册名为 ${call.name} 的工具`)
      const params = validate(tool.parameters, call.args)
      const result = await tool.execute(call.id, params)
      text = result.content.map((part) => part.text).join('\n')
    } catch (err) {
      // 工具抛异常不会让整个程序崩掉：内核把它变成一条带错误标记的工具结果回给模型
      isError = true
      text = `工具执行失败：${err instanceof Error ? err.message : String(err)}`
    }

    this.emit({ type: 'tool_execution_end', toolName: call.name, isError, text })
    this.messages.push({ role: 'tool', content: text, toolCallId: call.id, isError })
  }
}

/** 按 schema 校验模型填来的参数。校验失败也会变成一次工具错误回传给模型 */
function validate(schema: ObjectSchema, raw: Record<string, unknown>): Record<string, unknown> {
  for (const key of schema.required) {
    if (raw[key] === undefined) throw new Error(`缺少必填参数 ${key}`)
  }
  const validated: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.properties)) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== field.type) throw new Error(`参数 ${key} 应该是 ${field.type}`)
    validated[key] = value
  }
  return validated
}

export async function createAgentSession(
  options: CreateAgentSessionOptions
): Promise<{ session: AgentSession }> {
  const store = options.sessionManager ?? SessionManager.inMemory()
  const messages = store.messages
  if (messages.length === 0) {
    // 框架替你塞的那段默认人设 —— 你没写过它，但它决定了 Agent 怎么说话。D4 会把它换掉
    messages.push({ role: 'system', content: options.systemPrompt ?? '你是一个乐于助人的助手。' })
  }
  const session = new AgentSession(
    options.model,
    options.customTools ?? [],
    messages,
    options.maxTurns ?? 8
  )
  return { session }
}
