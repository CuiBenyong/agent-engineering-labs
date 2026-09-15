import 'dotenv/config'

/**
 * D3 实验（starter）：结构化抽取脚本
 * 把一段自然语言的需求描述抽成固定字段的 JSON（接口、方法、每个字段的校验规则、失败状态码、摘要）。
 * 重点不在调 API，而在三件事：schema 约束输出形状、模板与变量、解析失败的兜底。
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
type FieldType = 'string' | 'number' | 'boolean' | 'date'

interface Validation {
  field: string
  type: FieldType
  required: boolean
  rule: string
}

interface Spec {
  endpoint: string
  method: Method
  validations: Validation[]
  failureStatus: number
  summary: string
}

/**
 * schema 是给模型的「表格」：字段、类型、枚举、必填，一样都不能省。
 * 两家 API 的严格模式都要求 additionalProperties: false 且所有字段进 required。
 */
const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['endpoint', 'method', 'validations', 'failureStatus', 'summary'],
  properties: {
    endpoint: { type: 'string', description: '接口路径，例如 /todos 或 /todos/:id' },
    method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] },
    validations: {
      type: 'array',
      // 练习 1：补全 items 的 schema——field（string）、type（枚举四种）、required（boolean）、rule（string），
      // 四个字段都进 required，并加 additionalProperties: false（两家 API 的严格模式都要求）。
      // 提示：现在这个 items 只说「是对象」，模型可以往里塞任何字段，下游解析就没法信任它。
      items: { type: 'object' },
    },
    failureStatus: { type: 'integer', description: '校验失败时返回的 HTTP 状态码' },
    summary: { type: 'string', description: '一句话摘要，用 OUTPUT_LANG 指定的语言' },
  },
} as const

const LANG_NAME: Record<string, string> = { zh: '中文', en: 'English' }

/**
 * 模板与变量：提示词是一个函数，不是一段话。
 * 常量（角色、任务、约束）写死在模板里；每次都可能变的（语言、状态码默认值）做成参数。
 */
function buildSystemPrompt(lang: string, defaultStatus: number): string {
  // 练习 2：把这段提示词改成模板——用 LANG_NAME[lang] 决定 summary 的语言，用 defaultStatus 决定默认状态码。
  // 提示：现在语言和 400 都写死了，OUTPUT_LANG=en 跑一遍你会发现 summary 仍然是中文。
  void lang
  void defaultStatus
  void LANG_NAME
  return [
    '你是一位负责接口设计评审的后端工程师。',
    '任务：从用户给出的需求描述里抽取接口路径、HTTP 方法、每个请求字段的校验规则与失败状态码。',
    '需求里没提到失败状态码时用 400。字段类型只能是 string / number / boolean / date 四种。',
    'summary 字段必须使用中文书写，其余字段原样保留需求里的英文标识符。',
    '只填写需求里明确出现的字段，不要臆造。',
  ].join('\n')
}

// ---------- 网络出口：两家 provider 各一个函数，MOCK 在最前面打桩 ----------

let mockCalls = 0

/** 唯一的模型调用入口。返回的是「未经校验的任意对象」，校验交给 validateSpec。 */
async function extractRaw(system: string, requirement: string): Promise<unknown> {
  if (process.env.MOCK === '1') {
    mockCalls += 1
    // 含「乱码」的输入第一次故意返回一个类型错误的对象，用来演示校验 + 重试
    if (requirement.includes('乱码') && mockCalls % 2 === 1) {
      return {
        endpoint: '/todos',
        method: 'POST',
        validations: [],
        failureStatus: '400',
        summary: 'bad',
      }
    }
    const en = system.includes('English')
    return {
      endpoint: requirement.includes('/:id') ? '/todos/:id' : '/todos',
      method: requirement.includes('更新') ? 'PATCH' : 'POST',
      validations: [
        { field: 'title', type: 'string', required: true, rule: '非空且长度不超过 200' },
        { field: 'dueDate', type: 'date', required: false, rule: 'ISO 8601 日期字符串' },
      ],
      failureStatus: 400,
      summary: en
        ? 'Validate title and dueDate on the TODO endpoint; return 400 on failure.'
        : '为 TODO 接口的 title 与 dueDate 补校验，失败返回 400。',
    }
  }
  return process.env.PROVIDER === 'openai'
    ? extractWithOpenAI(system, requirement)
    : extractWithAnthropic(system, requirement)
}

/** Anthropic：用「强制调用一个工具」拿结构化输出，工具的 input_schema 就是我们的 schema。 */
async function extractWithAnthropic(system: string, requirement: string): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: requirement }],
      tools: [
        { name: 'record_spec', description: '记录抽取出的接口校验规格', input_schema: SPEC_SCHEMA },
      ],
      tool_choice: { type: 'tool', name: 'record_spec' }, // 强制走工具，模型就不会输出自由文本
    }),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { content: Array<{ type: string; input?: unknown }> }
  const block = json.content.find((c) => c.type === 'tool_use')
  if (!block) throw new Error('响应里没有 tool_use 块')
  return block.input
}

/** OpenAI：Responses API 的 json_schema 严格模式；模型 id 从环境变量读。 */
async function extractWithOpenAI(system: string, requirement: string): Promise<unknown> {
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY（或用 MOCK=1 离线运行）')
  if (!model) throw new Error('缺少 OPENAI_MODEL（以官方文档当前推荐的型号为准）')
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: system,
      input: requirement,
      text: { format: { type: 'json_schema', name: 'spec', schema: SPEC_SCHEMA, strict: true } },
    }),
  })
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as {
    output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>
  }
  const text = json.output
    .flatMap((o) => o.content ?? [])
    .find((c) => c.type === 'output_text')?.text
  if (!text) throw new Error('响应里没有 output_text')
  return JSON.parse(text) as unknown // 严格模式下这里几乎不会抛，但仍然要过 validateSpec
}

// ---------- 校验：schema 约束的是「形状」，业务规则还得自己查 ----------

const METHODS: readonly Method[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
const TYPES: readonly FieldType[] = ['string', 'number', 'boolean', 'date']

/** 返回错误列表；空数组表示通过。宁可多查一条，也不要让坏数据流进下游。 */
function validateSpec(raw: unknown): string[] {
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null) return ['不是对象']
  const o = raw as Record<string, unknown>
  if (typeof o.endpoint !== 'string' || !o.endpoint.startsWith('/'))
    errors.push('endpoint 必须是以 / 开头的字符串')
  if (!METHODS.includes(o.method as Method)) errors.push(`method 必须是 ${METHODS.join('/')} 之一`)
  // 练习 3：补上 failureStatus（4xx 整数）、summary（非空字符串）、validations（数组，且每一项的
  // field / type / required / rule 类型正确，type 要在 TYPES 里）的校验。
  // 提示：MOCK=1 跑第三条需求，你会看到 failureStatus 是字符串 "400" 却被当成功放过了——
  // schema 只能约束「形状」，「4xx」这种业务规则永远要自己查。
  void TYPES
  return errors
}

/**
 * 兜底三层：校验 → 重试一次（把错误原因喂回去）→ 降级为 null 并记录。
 * 重试时把错误列表拼进用户消息，让模型知道上一次错在哪，而不是原样再来一遍。
 */
async function extractSpec(requirement: string): Promise<Spec | null> {
  const lang = process.env.OUTPUT_LANG ?? 'zh'
  const system = buildSystemPrompt(lang, 400)
  // 练习 4：校验失败后重试一次，重试时把 errors 拼进用户消息告诉模型上一次错在哪；
  // 两次都失败才返回 null。提示：原样重发一遍大概率还是同样的错，要把错误原因喂回去。
  const raw = await extractRaw(system, requirement)
  const errors = validateSpec(raw)
  if (errors.length === 0) return raw as Spec
  console.error(`  校验失败：${errors.join('；')}（练习 4：这里应该带着错误原因重试一次）`)
  return null // 降级：调用方决定是人工处理还是跳过，不要把坏数据当成功
}

const REQUIREMENTS = [
  '创建 TODO 的接口 POST /todos 目前不校验请求体。title 必填，字符串，不超过 200 字符；dueDate 可选，必须是 ISO 日期。校验失败返回 400。',
  '更新接口 PATCH /todos/:id 需要补校验：title 如果传了必须非空字符串且不超过 200 字符；dueDate 可选 ISO 日期。失败时返回 400 与可读错误。',
  '这条需求里有乱码：POST /todos 的 title 必填，长度上限 200。',
]

async function main(): Promise<void> {
  const inputs = process.argv.length > 2 ? [process.argv.slice(2).join(' ')] : REQUIREMENTS
  console.log(
    `provider=${process.env.MOCK === '1' ? 'mock' : (process.env.PROVIDER ?? 'anthropic')} lang=${process.env.OUTPUT_LANG ?? 'zh'}\n`
  )
  for (const req of inputs) {
    console.log(`需求：${req}`)
    const spec = await extractSpec(req)
    console.log(
      spec ? JSON.stringify(spec, null, 2) : '→ 两次都没通过校验，已降级为 null，交人工处理'
    )
    console.log()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
