import 'dotenv/config'
import { CASES, type Case, type Expected } from './cases'
import { PROMPT_A, PROMPT_B, type PromptVersion } from './prompts'

/**
 * D4 实验（starter）：十条测试集的 A/B 评估脚本
 * 同一批输入、两版提示词、一张表看结果。
 * 判分只比 endpoint / method / failureStatus / fields 四个字段，并容忍顺序与大小写差异。
 */

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['endpoint', 'method', 'failureStatus', 'fields'],
  properties: {
    endpoint: { type: 'string' },
    method: { type: 'string' },
    failureStatus: { type: 'integer' },
    fields: { type: 'array', items: { type: 'string' } },
  },
} as const

// ---------- 模型出口：MOCK 在最前面打桩 ----------

/**
 * MOCK 下用规则模拟「v1 会在哪些边界上出错」：没写状态码就猜 422、口语路径还原不出来、
 * 改口只认第一次。v2 修了这些，但在 c10 上过度纠正（需求写了 422 也改回 400）。
 * 这不是在作弊——离线时你需要看到「两版有差异、且差异可解释」的现象，才能练判分与汇总。
 */
function mockExtract(version: PromptVersion, c: Case): Expected {
  const e = { ...c.expected, fields: [...c.expected.fields] }
  if (version.id === 'v1') {
    if (c.id === 'c04') e.failureStatus = 422
    if (c.id === 'c05') e.endpoint = '/todo'
    if (c.id === 'c07') e.fields = ['page']
    if (c.id === 'c09') e.endpoint = '/todos/:id'
    // 顺序与大小写故意打乱：判分要容忍这些
    e.method = e.method.toLowerCase()
    e.fields.reverse()
  } else if (c.id === 'c10') {
    e.failureStatus = 400 // v2 把「没写就 400」学得太死，需求写了 422 也改成 400
  }
  return e
}

async function extract(version: PromptVersion, c: Case): Promise<unknown> {
  if (process.env.MOCK === '1') return mockExtract(version, c)
  return process.env.PROVIDER === 'openai'
    ? extractWithOpenAI(version.system, c.input)
    : extractWithAnthropic(version.system, c.input)
}

async function extractWithAnthropic(system: string, input: string): Promise<unknown> {
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
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: input }],
      tools: [{ name: 'record_spec', description: '记录抽取结果', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'record_spec' },
    }),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { content: Array<{ type: string; input?: unknown }> }
  return json.content.find((b) => b.type === 'tool_use')?.input
}

async function extractWithOpenAI(system: string, input: string): Promise<unknown> {
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
      input,
      text: { format: { type: 'json_schema', name: 'spec', schema: SCHEMA, strict: true } },
    }),
  })
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as {
    output: Array<{ content?: Array<{ type: string; text?: string }> }>
  }
  const text = json.output
    .flatMap((o) => o.content ?? [])
    .find((p) => p.type === 'output_text')?.text
  return text ? (JSON.parse(text) as unknown) : null
}

// ---------- 判分：字段比对，容忍顺序与大小写 ----------

// 练习 2：现在是「整个对象序列化后完全相等」才算对。MOCK=1 跑一下你会看到 v1 十条全挂，
// 但其中好几条只是方法小写了、fields 顺序反了——这不是提示词的错，是判分太死。
// 改成逐字段比对：endpoint 忽略大小写与末尾斜杠、缺前导斜杠视为可容忍；method 忽略大小写；
// fields 去重、忽略顺序与大小写；failureStatus 精确相等。返回不匹配的字段名列表，空数组即通过。
function score(actual: unknown, expected: Expected): string[] {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  return same ? [] : ['(strict mismatch)']
}

// ---------- 汇总：逐条对比表 + 通过率 + 互有胜负 ----------

interface Row {
  id: string
  kind: string
  a: string[]
  b: string[]
}

function printReport(rows: Row[], a: PromptVersion, b: PromptVersion): void {
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length))
  const mark = (diffs: string[]): string => (diffs.length === 0 ? '✅' : `❌ ${diffs.join(',')}`)
  console.log(`${pad('case', 6)}${pad('kind', 13)}${pad(a.id, 26)}${b.id}`)
  for (const r of rows)
    console.log(`${pad(r.id, 6)}${pad(r.kind, 13)}${pad(mark(r.a), 26)}${mark(r.b)}`)

  // 练习 3：补汇总。要算：两版各自的通过率（n/10 与百分比）、「B 修好的」（A 挂 B 过）、
  // 「B 弄坏的」（A 过 B 挂）、以及 B 按 kind 分类的通过数。
  // 提示：「弄坏的」那一栏比总分更重要，它就是 CHANGELOG 里「已知回退」的来源。
  void a
  void b
  console.log('\n通过率：（练习 3：在这里输出两版通过率与互有胜负的条目）')
}

async function main(): Promise<void> {
  console.log(
    `provider=${process.env.MOCK === '1' ? 'mock' : (process.env.PROVIDER ?? 'anthropic')}  cases=${CASES.length}\n`
  )
  const rows: Row[] = []
  for (const c of CASES) {
    // 两版对同一条输入各跑一次；真模型下为了控制随机性可以每条跑 N 次取多数
    const [ra, rb] = await Promise.all([extract(PROMPT_A, c), extract(PROMPT_B, c)])
    rows.push({ id: c.id, kind: c.kind, a: score(ra, c.expected), b: score(rb, c.expected) })
  }
  printReport(rows, PROMPT_A, PROMPT_B)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
