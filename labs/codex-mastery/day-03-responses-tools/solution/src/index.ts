import 'dotenv/config'
import OpenAI from 'openai'
import { z } from 'zod'
import { zodTextFormat } from 'openai/helpers/zod'

/**
 * D3 实验：带内置工具的 Responses API 最小脚本。
 *
 * 用法：
 *   MOCK=1 pnpm start "还有哪些没做完"            # 函数调用来回
 *   MOCK=1 pnpm start --search "Express 校验库"    # web search 内置工具
 *   MOCK=1 pnpm start --structured "审查这段 diff" # 结构化输出 + refusal
 *   去掉 MOCK=1 并配置 OPENAI_API_KEY / OPENAI_MODEL 走真模型。
 */

// ---------- 我们只依赖 Responses 输出里的这几种 item，收窄成自己的类型 ----------

interface FunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

interface MessageItem {
  type: 'message'
  text: string
  citations: string[]
  refusal: string | null
}

type OutputItem = FunctionCallItem | MessageItem

interface MinimalResponse {
  id: string
  output: OutputItem[]
  output_text: string
  output_parsed: unknown
}

type FunctionCallOutput = { type: 'function_call_output'; call_id: string; output: string }

interface CallParams {
  input: string | FunctionCallOutput[]
  tools?: OpenAI.Responses.Tool[]
  previous_response_id?: string
  /** 结构化输出：传 zod schema 时走 responses.parse */
  schema?: z.ZodTypeAny
}

// ---------- 业务数据：一个内存里的 TODO 列表 ----------

const todos = [
  { id: 1, title: '给 POST /todos 补输入校验', done: false },
  { id: 2, title: '给 GET /todos 补单元测试', done: true },
  { id: 3, title: '把校验规则抽成常量', done: false },
]

const tools: OpenAI.Responses.Tool[] = [
  {
    type: 'function',
    name: 'list_todos',
    description: '列出当前所有 TODO，含 id、title、done',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
]

/** 本地真的去执行工具：这一步在 MOCK 下也真实执行，MOCK 只打桩网络 */
function runTool(call: FunctionCallItem): string {
  if (call.name === 'list_todos') return JSON.stringify(todos)
  return JSON.stringify({ error: `未知工具 ${call.name}` })
}

const Review = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  issues: z.array(z.object({ file: z.string(), line: z.number(), note: z.string() })),
})

// ---------- 唯一的网络出口：MOCK 在这里打桩 ----------

let mockTurn = 0

async function callModel(params: CallParams): Promise<MinimalResponse> {
  if (process.env.MOCK === '1') {
    await new Promise((r) => setTimeout(r, 200))
    return mockResponse(params)
  }

  if (!process.env.OPENAI_API_KEY) throw new Error('缺少 OPENAI_API_KEY（或用 MOCK=1 离线运行）')
  const model = process.env.OPENAI_MODEL
  if (!model) throw new Error('缺少 OPENAI_MODEL（以官方文档当前推荐的模型为准）')

  const client = new OpenAI()
  const base = {
    model,
    instructions: '你是一个 TODO API 项目的助手，回答简短，需要数据时调用工具。',
    input: params.input,
    tools: params.tools,
    previous_response_id: params.previous_response_id,
  }

  if (params.schema) {
    const res = await client.responses.parse({
      ...base,
      text: { format: zodTextFormat(params.schema, 'review') },
    })
    return { ...toMinimal(res), output_parsed: res.output_parsed }
  }
  const res = await client.responses.create(base)
  return toMinimal(res)
}

/** 把 SDK 的完整 Response 收窄成我们用到的形状（顺手把 annotations 里的来源抽出来） */
function toMinimal(res: OpenAI.Responses.Response): MinimalResponse {
  const output: OutputItem[] = []
  for (const item of res.output) {
    if (item.type === 'function_call') {
      output.push({
        type: 'function_call',
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      })
    } else if (item.type === 'message') {
      let text = ''
      let refusal: string | null = null
      const citations: string[] = []
      for (const part of item.content) {
        if (part.type === 'output_text') {
          text += part.text
          for (const a of part.annotations) if (a.type === 'url_citation') citations.push(a.url)
        } else if (part.type === 'refusal') {
          refusal = part.refusal
        }
      }
      output.push({ type: 'message', text, citations, refusal })
    }
  }
  return { id: res.id, output, output_text: res.output_text, output_parsed: null }
}

/** 离线假数据：形状与真实响应一致，节奏也一致（第一轮请求工具，第二轮给答案） */
function mockResponse(params: CallParams): MinimalResponse {
  mockTurn += 1
  const id = `resp_mock_${mockTurn}`

  if (params.schema) {
    const text = typeof params.input === 'string' ? params.input : ''
    if (text.includes('删库')) {
      return {
        id,
        output: [
          {
            type: 'message',
            text: '',
            citations: [],
            refusal: '这个请求涉及破坏性操作，我不能协助。',
          },
        ],
        output_text: '',
        output_parsed: null,
      }
    }
    const parsed = {
      verdict: 'request_changes',
      issues: [{ file: 'src/todo.ts', line: 12, note: 'title 的长度上限应抽成常量' }],
    }
    return {
      id,
      output: [{ type: 'message', text: JSON.stringify(parsed), citations: [], refusal: null }],
      output_text: JSON.stringify(parsed),
      output_parsed: parsed,
    }
  }

  const hasSearch = params.tools?.some((t) => t.type === 'web_search') ?? false
  if (hasSearch) {
    const text = '离线模拟：社区常用 zod、joi、express-validator 做请求体校验。'
    return {
      id,
      output: [
        { type: 'message', text, citations: ['https://example.com/mock-source'], refusal: null },
      ],
      output_text: text,
      output_parsed: null,
    }
  }

  // 第一轮：模型请求调用 list_todos；第二轮（input 是回填）：基于结果作答
  if (typeof params.input === 'string') {
    return {
      id,
      output: [
        { type: 'function_call', call_id: 'call_mock_1', name: 'list_todos', arguments: '{}' },
      ],
      output_text: '',
      output_parsed: null,
    }
  }
  const data = JSON.parse(params.input[0]?.output ?? '[]') as typeof todos
  const pending = data.filter((t) => !t.done).map((t) => `「${t.title}」`)
  const text = `离线模拟：还有 ${pending.length} 件没做完：${pending.join('、')}。`
  return {
    id,
    output: [{ type: 'message', text, citations: [], refusal: null }],
    output_text: text,
    output_parsed: null,
  }
}

// ---------- 三种模式 ----------

/** 函数调用来回：请求 → 本地执行 → 回填 → 最终回答 */
async function chatWithTools(question: string): Promise<void> {
  const first = await callModel({ input: question, tools })
  const calls = first.output.filter((i): i is FunctionCallItem => i.type === 'function_call')
  if (calls.length === 0) {
    console.log(first.output_text)
    return
  }
  for (const c of calls) console.log(`[工具] 模型请求 ${c.name}(${c.arguments})`)

  const outputs: FunctionCallOutput[] = calls.map((c) => ({
    type: 'function_call_output',
    call_id: c.call_id, // call_id 必须原样对上，模型靠它配对请求与结果
    output: runTool(c),
  }))
  const second = await callModel({ input: outputs, tools, previous_response_id: first.id })
  console.log(second.output_text)
}

/** web search 内置工具：不用回填，只把来源列出来 */
async function chatWithSearch(question: string): Promise<void> {
  const res = await callModel({
    input: question,
    tools: [{ type: 'web_search', search_context_size: 'low' }],
  })
  console.log(res.output_text)
  for (const item of res.output) {
    if (item.type === 'message') for (const url of item.citations) console.log('来源：', url)
  }
}

/** 结构化输出：先看 refusal，再读 output_parsed */
async function structuredReview(input: string): Promise<void> {
  const res = await callModel({ input, schema: Review })
  const refused = res.output.find(
    (i): i is MessageItem => i.type === 'message' && i.refusal !== null
  )
  if (refused) {
    console.log('模型拒绝了：', refused.refusal)
    return
  }
  const review = Review.parse(res.output_parsed) // strict 模式保证格式，业务校验仍由我们做
  console.log(`结论：${review.verdict}，问题 ${review.issues.length} 条`)
  for (const issue of review.issues) console.log(`  ${issue.file}:${issue.line} ${issue.note}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const mode = args[0]?.startsWith('--') ? args.shift() : undefined
  const text = args.join(' ').trim()
  if (!text) {
    console.log('用法：pnpm start [--search|--structured] "一句话"')
    return
  }
  if (mode === '--search') await chatWithSearch(text)
  else if (mode === '--structured') await structuredReview(text)
  else await chatWithTools(text)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
