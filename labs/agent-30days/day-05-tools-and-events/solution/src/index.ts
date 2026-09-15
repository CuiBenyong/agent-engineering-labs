// D5 实验（solution）：4 个工具 + 事件监听输出进度/typing
//
// 一次性脚本：跑一轮 Agent 循环就结束，不需要喂管道。
//   MOCK=1 pnpm start                 离线跑，退款会被权限闸拦下
//   MOCK=1 APPROVE=1 pnpm start       离线跑，模拟人工点了「同意」
import 'dotenv/config'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** 一个参数字段的 schema。description 是写给模型看的，会原样进入上下文。 */
interface FieldSchema {
  type: 'string' | 'number' | 'integer'
  description: string
  pattern?: string
  enum?: string[]
  minimum?: number
  minLength?: number
}

interface ToolSchema {
  type: 'object'
  properties: Record<string, FieldSchema>
  required: string[]
}

/** 可逆性分档：决定这个工具要不要人工确认，比按「读写」分更贴近真实风险。 */
type Risk = 'readonly' | 'reversible' | 'irreversible'

interface ToolSpec {
  name: string
  description: string
  risk: Risk
  parameters: ToolSchema
  execute: (args: Record<string, JsonValue>) => Promise<string>
}

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, JsonValue>
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ApiToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string }

interface ApiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ModelTurn = { kind: 'text'; text: string } | { kind: 'tool_call'; call: ToolCall }

/** Agent 生命周期事件。跨进程传输后顺序不保证，所以每条都带 runId 和自增 seq。 */
type AgentEvent =
  | { type: 'run:start'; runId: string; seq: number; input: string }
  | { type: 'model:delta'; runId: string; seq: number; text: string }
  | { type: 'tool:proposed'; runId: string; seq: number; tool: string }
  | { type: 'tool:start'; runId: string; seq: number; tool: string }
  | { type: 'tool:end'; runId: string; seq: number; tool: string; ms: number; result: string }
  | { type: 'tool:error'; runId: string; seq: number; tool: string; message: string }
  | { type: 'approval:required'; runId: string; seq: number; tool: string }
  | { type: 'run:end'; runId: string; seq: number; toolCalls: number }

// ---------------------------------------------------------------------------
// 事件总线：最朴素的发布订阅，不需要任何消息中间件
// ---------------------------------------------------------------------------

class EventBus {
  private readonly listeners: ((event: AgentEvent) => void)[] = []
  private seq = 0

  on(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener)
  }

  /** 序号在总线内部自增，调用方不用记，也就不会记错。 */
  emit(make: (seq: number) => AgentEvent): void {
    this.seq += 1
    const event = make(this.seq)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        // 事件是旁路不是主干：监听器抛错绝不能炸掉主循环，真实项目里这里上报日志
        void err
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4 个工具。description 里都写了「什么时候不该用它」，这一句能砍掉一大半误用。
// ---------------------------------------------------------------------------

const ORDER_ID: FieldSchema = {
  type: 'string',
  description: '订单号，SO 开头加 8 位数字，例如 SO20260901',
  pattern: '^SO\\d{8}$',
}

const TOOLS: ToolSpec[] = [
  {
    name: 'query_order',
    description:
      '按订单号查询一笔订单的状态、金额和下单时间。只查订单本身；物流轨迹请用 track_shipment，退款请用 apply_refund。',
    risk: 'readonly',
    parameters: { type: 'object', properties: { order_id: ORDER_ID }, required: ['order_id'] },
    execute: async (args) => {
      // 防御性断言：正常情况下 validate 已经挡住了，跑到这里说明校验被跳过了
      if (typeof args.order_id !== 'string') {
        throw new Error(
          `工具内部崩了：order_id 期望字符串，实际是${describeType(args.order_id)}——这就是没有校验的下场`
        )
      }
      return args.order_id === 'SO20260901'
        ? '订单 SO20260901：已发货，实付 69.00 元，下单时间 2026-09-01。'
        : `未找到订单 ${args.order_id}。`
    },
  },
  {
    name: 'track_shipment',
    description:
      '按订单号查询物流轨迹与最新状态。只查物流；订单金额和状态请用 query_order，不要用它判断能不能退款。',
    risk: 'readonly',
    parameters: { type: 'object', properties: { order_id: ORDER_ID }, required: ['order_id'] },
    execute: async () => '物流轨迹：09-01 已揽收 → 09-02 到达转运中心 → 之后无更新，已停滞 3 天。',
  },
  {
    name: 'apply_refund',
    description:
      '对一笔订单发起退款。不可逆操作，必须先用 query_order 确认金额；只负责提交退款，不负责通知用户。',
    risk: 'irreversible',
    parameters: {
      type: 'object',
      properties: {
        order_id: ORDER_ID,
        amount_cents: {
          type: 'integer',
          description: '退款金额，单位是分的整数，例如 6900 表示 69 元',
          minimum: 1,
        },
        reason: { type: 'string', description: '退款原因，至少 4 个字', minLength: 4 },
      },
      required: ['order_id', 'amount_cents', 'reason'],
    },
    execute: async (args) =>
      `[已退款] 订单 ${String(args.order_id)} 退款 ${
        Number(args.amount_cents) / 100
      } 元已提交，预计 3 个工作日到账。`,
  },
  {
    name: 'send_sms_notice',
    description:
      '给用户手机号发一条模板短信。不可逆操作，只能发预置模板，不能发自由文本，也不要用它做二次营销。',
    risk: 'irreversible',
    parameters: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: '11 位手机号，1 开头，例如 13800000000',
          pattern: '^1\\d{10}$',
        },
        template_id: {
          type: 'string',
          description: '短信模板 id',
          enum: ['refund_done', 'shipment_delay'],
        },
      },
      required: ['phone', 'template_id'],
    },
    execute: async (args) =>
      `[已发短信] 模板 ${String(args.template_id)} 已发送至 ${String(args.phone)}。`,
  },
]

const SYSTEM_PROMPT = [
  '你是「某电商平台」的售后助手。',
  '',
  '【能力边界】',
  '- 只回答订单、退换货、物流相关问题',
  '- 退款前必须先查询订单确认金额，不要凭记忆回答',
  '',
  '【输出要求】',
  '- 回复不超过 3 句话，不使用 Markdown 标题和列表',
].join('\n')

// ---------------------------------------------------------------------------
// 参数校验：把非法输入挡在工具外面，而不是让工具本身崩掉
// ---------------------------------------------------------------------------

function describeType(value: JsonValue | undefined): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  switch (typeof value) {
    case 'string':
      return '字符串'
    case 'number':
      return '数字'
    case 'boolean':
      return '布尔值'
    default:
      return '对象'
  }
}

/** 一次把全部错误报出来。报了第一条就返回，会让模型多跑好几轮。 */
function validate(spec: ToolSpec, args: Record<string, JsonValue>): string[] {
  const errors: string[] = []
  const { properties, required } = spec.parameters

  for (const field of required) {
    const value = args[field]
    if (value === undefined || value === null || value === '') {
      errors.push(`缺少必填参数 ${field}；期望：${properties[field]?.description ?? '见工具说明'}`)
    }
  }

  for (const [field, rule] of Object.entries(properties)) {
    const value = args[field]
    if (value === undefined || value === null || value === '') continue

    if (rule.type === 'string') {
      if (typeof value !== 'string') {
        errors.push(
          `参数 ${field} 需要字符串，你传的是${describeType(value)} ${JSON.stringify(value)}；期望：${rule.description}`
        )
        continue
      }
      if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) {
        errors.push(
          `参数 ${field} 格式不正确，你传的是 ${JSON.stringify(value)}；期望：${rule.description}`
        )
      }
      if (rule.enum !== undefined && !rule.enum.includes(value)) {
        errors.push(
          `参数 ${field} 只能取 ${rule.enum.join(' / ')} 之一，你传的是 ${JSON.stringify(value)}`
        )
      }
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        errors.push(`参数 ${field} 至少要 ${rule.minLength} 个字符；期望：${rule.description}`)
      }
      continue
    }

    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push(
        `参数 ${field} 需要数字，你传的是${describeType(value)} ${JSON.stringify(value)}；期望：${rule.description}`
      )
      continue
    }
    if (rule.type === 'integer' && !Number.isInteger(value)) {
      errors.push(`参数 ${field} 需要整数，你传的是 ${value}；期望：${rule.description}`)
    }
    if (rule.minimum !== undefined && value < rule.minimum) {
      errors.push(`参数 ${field} 不能小于 ${rule.minimum}，你传的是 ${value}`)
    }
  }

  return errors
}

/**
 * 把校验失败翻译成模型能读懂的下一步指引。
 * 三个要素缺一不可：错在哪个字段、期望是什么、一个合法示例（示例在 description 里）。
 * 注意这里只能出现字段名和期望格式——栈信息、SQL、内部路径会被模型复述给用户。
 */
function toToolErrorMessage(spec: ToolSpec, errors: string[]): string {
  return `${errors.join('；')}。请修正后重新调用 ${spec.name}。`
}

// ---------------------------------------------------------------------------
// 权限边界：提示词管意图，代码管权限
// ---------------------------------------------------------------------------

/** 小额退款自动放行，是参数级上限——比「整个工具都要确认」实用得多。 */
const AUTO_REFUND_LIMIT_CENTS = 5000

function requiresApproval(spec: ToolSpec, args: Record<string, JsonValue>): boolean {
  if (spec.risk !== 'irreversible') return false
  if (spec.name === 'apply_refund' && typeof args.amount_cents === 'number') {
    return args.amount_cents > AUTO_REFUND_LIMIT_CENTS
  }
  return true
}

/** 返回 null 表示放行；返回字符串表示被拦下，这段文字要作为工具结果回传给模型。 */
function askApproval(spec: ToolSpec, args: Record<string, JsonValue>): string | null {
  if (!requiresApproval(spec, args)) return null
  if (process.env.APPROVE === '1') {
    console.log(`[已确认] ${spec.name}：模拟人工点了「同意」`)
    return null
  }
  console.log(`[待确认] ${spec.name} 是不可逆操作，未获人工确认。加上 APPROVE=1 重跑可放行。`)
  // 拒绝也是一种结果，必须回传，模型才能改口而不是傻等或反复重试
  return '用户拒绝了这次操作（未获得人工确认）。请改为告知用户已登记工单，不要重试。'
}

// ---------------------------------------------------------------------------
// 事件到界面文案的映射：用户要的不是 tool:start，是一句人话
// ---------------------------------------------------------------------------

const PROGRESS_TEXT: Record<string, string> = {
  query_order: '正在查询订单…',
  track_shipment: '正在查询物流…',
  apply_refund: '正在提交退款…',
  send_sms_notice: '正在发送短信通知…',
}

function renderProgress(event: AgentEvent): void {
  switch (event.type) {
    case 'run:start':
      console.log('[界面] typing 三个点亮起')
      break
    case 'tool:proposed':
      console.log(`[事件] tool:proposed ${event.tool}`)
      break
    case 'tool:start':
      console.log(`[界面] ${PROGRESS_TEXT[event.tool] ?? '正在处理…'}`)
      break
    case 'tool:end':
      console.log(`[事件] tool:end ${event.tool}（${event.ms}ms）→ ${event.result}`)
      break
    case 'tool:error':
      console.log(`[事件] tool:error ${event.tool}：${event.message}`)
      break
    case 'approval:required':
      console.log(`[界面] ${event.tool} 需要确认，弹出确认卡片，typing 暂停`)
      break
    case 'model:delta':
      // 打字机效果。真实前端要按 50ms 时间窗合批，否则一个 token 一帧会压垮连接
      process.stdout.write(event.text)
      break
    case 'run:end':
      console.log(`\n[界面] typing 收起（本轮共 ${event.toolCalls} 次工具调用）`)
      break
  }
}

// ---------------------------------------------------------------------------
// 假模型：只在 MOCK=1 下用，靠关键词匹配近似「模型读懂了错误」，是演示级实现
// ---------------------------------------------------------------------------

function lastToolMessage(messages: ChatMessage[]): { name: string; content: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'tool') return { name: message.name, content: message.content }
  }
  return undefined
}

function failureCount(messages: ChatMessage[], tool: string): number {
  return messages.filter(
    (m) => m.role === 'tool' && m.name === tool && m.content.startsWith('调用失败')
  ).length
}

function mockModel(messages: ChatMessage[]): ModelTurn {
  const last = lastToolMessage(messages)
  const call = (name: string, args: Record<string, JsonValue>): ModelTurn => ({
    kind: 'tool_call',
    call: { id: `call_${messages.length}`, name, arguments: args },
  })

  // 第一次调用故意把 order_id 传成数字——模型是概率生成参数的，不是编译器
  if (last === undefined) return call('query_order', { order_id: 12345 })

  if (last.content.startsWith('调用失败')) {
    // 错误信息里带了合法示例，模型才知道该怎么改；否则只能放弃
    if (last.content.includes('SO20260901') && failureCount(messages, 'query_order') < 2) {
      return call('query_order', { order_id: 'SO20260901' })
    }
    return {
      kind: 'text',
      text: '抱歉，我没能查到您的订单，已为您登记工单。（错误信息里没有可用的格式提示，模型放弃了纠错）',
    }
  }

  switch (last.name) {
    case 'query_order':
      return call('track_shipment', { order_id: 'SO20260901' })
    case 'track_shipment':
      return call('apply_refund', {
        order_id: 'SO20260901',
        amount_cents: 6900,
        reason: '物流停滞超过 3 天',
      })
    case 'apply_refund':
      if (last.content.includes('用户拒绝')) {
        return { kind: 'text', text: '已为您登记退款申请，稍后由人工客服跟进，请留意短信通知。' }
      }
      return call('send_sms_notice', { phone: '13800000000', template_id: 'refund_done' })
    default:
      return { kind: 'text', text: '已为您办理完成：订单 SO20260901 退款 69 元，短信通知已发出。' }
  }
}

// ---------------------------------------------------------------------------
// 真模型：唯一的网络出口。MOCK 判断放在函数最前面，真实分支一行都不执行
// ---------------------------------------------------------------------------

async function callModel(messages: ChatMessage[]): Promise<ModelTurn> {
  if (process.env.MOCK === '1') return mockModel(messages)

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages,
      // 工具定义每一轮都会被完整重发：这就是那笔按轮次重复付的固定成本
      tools: TOOLS.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`模型返回 HTTP ${res.status}`)

  const json = (await res.json()) as {
    choices: { message: { content: string | null; tool_calls?: ApiToolCall[] } }[]
  }
  const message = json.choices[0].message
  const apiCall = message.tool_calls?.[0]
  if (apiCall === undefined) return { kind: 'text', text: message.content ?? '' }

  const parsed: unknown = JSON.parse(apiCall.function.arguments)
  const args =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, JsonValue>)
      : {}
  return {
    kind: 'tool_call',
    call: { id: apiCall.id, name: apiCall.function.name, arguments: args },
  }
}

// ---------------------------------------------------------------------------
// 工具执行：校验失败、权限拦截、执行报错，三条路都变成一条 tool 消息回到 messages
// ---------------------------------------------------------------------------

const MAX_STEPS = 8

async function runTool(
  call: ToolCall,
  messages: ChatMessage[],
  bus: EventBus,
  runId: string
): Promise<void> {
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      },
    ],
  })

  const push = (content: string): void => {
    messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content })
  }

  const spec = TOOLS.find((tool) => tool.name === call.name)
  if (spec === undefined) {
    push(
      `调用失败。没有名为 ${call.name} 的工具，可用工具是 ${TOOLS.map((t) => t.name).join('、')}。`
    )
    return
  }

  bus.emit((seq) => ({ type: 'tool:proposed', runId, seq, tool: spec.name }))

  const errors = validate(spec, call.arguments)
  if (errors.length > 0) {
    const detail = toToolErrorMessage(spec, errors)
    bus.emit((seq) => ({ type: 'tool:error', runId, seq, tool: spec.name, message: detail }))
    push(`调用失败。${detail}`)
    return
  }

  // 权限闸在执行之前：模型只能「提议」不可逆操作，落地与否由代码决定
  const rejected = askApproval(spec, call.arguments)
  if (rejected !== null) {
    bus.emit((seq) => ({ type: 'approval:required', runId, seq, tool: spec.name }))
    push(rejected)
    return
  }

  bus.emit((seq) => ({ type: 'tool:start', runId, seq, tool: spec.name }))
  const startedAt = Date.now()
  try {
    const result = await spec.execute(call.arguments)
    bus.emit((seq) => ({
      type: 'tool:end',
      runId,
      seq,
      tool: spec.name,
      ms: Date.now() - startedAt,
      result,
    }))
    push(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    bus.emit((seq) => ({ type: 'tool:error', runId, seq, tool: spec.name, message }))
    console.log(`[工具异常] ${spec.name}：${message}`)
    push(`调用失败。${message}`)
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function chunks(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const userInput = process.argv.slice(2).join(' ') || '我的单还没到，帮我查一下，超过 3 天就退款'
  const bus = new EventBus()
  bus.on(renderProgress)

  const runId = `run-${Date.now()}`
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userInput },
  ]

  console.log(`你> ${userInput}`)
  bus.emit((seq) => ({ type: 'run:start', runId, seq, input: userInput }))

  let toolCalls = 0
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const turn = await callModel(messages)
    if (turn.kind === 'text') {
      messages.push({ role: 'assistant', content: turn.text })
      process.stdout.write('助教> ')
      for (const chunk of chunks(turn.text, 4)) {
        bus.emit((seq) => ({ type: 'model:delta', runId, seq, text: chunk }))
        await sleep(20)
      }
      break
    }
    toolCalls += 1
    await runTool(turn.call, messages, bus, runId)
  }

  bus.emit((seq) => ({ type: 'run:end', runId, seq, toolCalls }))
  console.log(
    `[usage] messages=${messages.length} 条——工具用得越顺，这个数字涨得越快（D6 会处理它）`
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
