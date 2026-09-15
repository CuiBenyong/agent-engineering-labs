// D1 实验（starter）：上下文用量剖面脚本
// 把一次会话的请求体拆成系统提示 / 工具定义 / 对话历史 / 工具结果四块，分别计数并输出占比表。
//
// 四个练习点见下面的「练习 N」注释。现在直接跑 MOCK=1 pnpm start 是能跑通的，
// 但你会看到：工具结果那一行是 0、占比全是 0.0%、估算出来的 token 数大得离谱——
// 这就是「还没做完」的样子。

import 'dotenv/config'
import {
  loadTools,
  MESSAGES,
  SYSTEM_PROMPT,
  type Block,
  type Message,
  type Tool,
} from './fixture.js'

const MODEL = process.env.MODEL ?? 'claude-sonnet-5'
const WINDOW = Number(process.env.WINDOW ?? 200_000)
const TOOL_COUNT = Number(process.env.TOOL_COUNT ?? 3)
const IS_MOCK = process.env.MOCK === '1'

type Buckets = {
  system: string
  tools: Tool[]
  history: Message[]
  toolResults: ToolResultEntry[]
}
type ToolResultEntry = { tool_use_id: string; content: string }

/**
 * 练习 1：把一次请求拆成四块。
 * 现在的实现把所有内容块都当成对话历史，所以工具结果那一行永远是 0。
 * 提示：工具结果虽然写在 user 消息里，但它不是用户说的话——
 * 遍历每条消息的 content，把 type 为 tool_result 的块挑进 toolResults，其余留在 history。
 * 注意：挑空之后如果这条消息一个块都不剩，就不要再往 history 里放一条空消息。
 */
export function splitContext(system: string, tools: Tool[], messages: Message[]): Buckets {
  const history: Message[] = []
  const toolResults: ToolResultEntry[] = []

  for (const msg of messages) {
    const kept: Block[] = [...msg.content]
    if (kept.length > 0) history.push({ role: msg.role, content: kept })
  }

  return { system, tools, history, toolResults }
}

/**
 * 练习 2：离线估算器。
 * 现在直接返回字符数，比真实 token 数大很多（英文尤其离谱）。
 * 提示：汉字与全角标点大约 1 个字 1 个 token，ASCII 大约 3.5 个字符 1 个 token。
 * 判断汉字可以用 /[　-〿一-鿿＀-￯]/ 这个区间。
 */
export function estimateTokens(input: unknown): number {
  const text = typeof input === 'string' ? input : JSON.stringify(input)
  if (!text) return 0
  return text.length
}

type CountPayload = {
  system?: string
  tools?: Tool[]
  messages: Message[]
}

/** 唯一的网络出口。MOCK=1 时一行真实请求都不发。 */
async function countRemote(payload: CountPayload): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, ...payload }),
  })
  if (!res.ok) throw new Error(`计数接口返回 ${res.status}：${await res.text()}`)
  const json = (await res.json()) as { input_tokens: number }
  return json.input_tokens
}

const DOT: Message[] = [{ role: 'user', content: [{ type: 'text', text: '.' }] }]

export type Profile = {
  rows: { label: string; tokens: number; note: string }[]
  total: number
  source: '离线估算' | '计数接口差分'
}

/**
 * 练习 3：差分计数。
 * 计数接口只肯告诉你一个总数，想知道某一块占多少，就用「带这一块的请求」减「不带的请求」：
 *   baseline        = countRemote({ messages: DOT })
 *   系统提示        = countRemote({ system, messages: DOT }) - baseline
 *   工具定义        = countRemote({ system, tools, messages: DOT }) - 上一行的结果
 *   历史 + 工具结果 = countRemote(完整请求) - countRemote({ system, tools, messages: DOT })
 * 最后一块接口拆不开（工具结果必须紧跟在对应的 tool_use 后面，单独发会被拒），
 * 所以按 estimateTokens 算出的比例二次拆分，并在 note 里注明这一步是估的。
 * 现在的实现只发了一次完整请求，把全部 token 都记在「对话历史」头上。
 */
async function profileRemote(b: Buckets): Promise<Profile> {
  const full = await countRemote({ system: b.system, tools: b.tools, messages: MESSAGES })

  return {
    source: '计数接口差分',
    total: full,
    rows: [
      { label: '基础开销', tokens: 0, note: '空请求也要付的模板成本' },
      { label: '系统提示', tokens: 0, note: '每一轮都重发' },
      { label: '工具定义', tokens: 0, note: `${b.tools.length} 个工具` },
      { label: '对话历史', tokens: full, note: '还没拆开' },
      { label: '工具结果', tokens: 0, note: `${b.toolResults.length} 次工具返回` },
    ],
  }
}

function profileOffline(b: Buckets): Profile {
  const rows = [
    { label: '基础开销', tokens: 8, note: '空请求也要付的模板成本（离线按固定值算）' },
    { label: '系统提示', tokens: estimateTokens(b.system), note: '每一轮都重发' },
    { label: '工具定义', tokens: estimateTokens(b.tools), note: `${b.tools.length} 个工具` },
    { label: '对话历史', tokens: estimateTokens(b.history), note: '用户与助手的自然语言部分' },
    {
      label: '工具结果',
      tokens: estimateTokens(b.toolResults),
      note: `${b.toolResults.length} 次工具返回`,
    },
  ]
  return { source: '离线估算', total: rows.reduce((s, r) => s + r.tokens, 0), rows }
}

export function renderProfile(p: Profile, window: number): string {
  const pad = (s: string, n: number) =>
    s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (/[一-鿿]/.test(c) ? 2 : 1), 0)))
  const lines: string[] = []
  lines.push(`来源：${p.source}    模型：${MODEL}`)
  lines.push('')
  lines.push(`${pad('块', 12)}${pad('token', 10)}${pad('占比', 10)}说明`)
  lines.push('-'.repeat(64))
  for (const r of p.rows) {
    // 练习 4：算出这一行占总数的百分比（现在写死成 0）。
    const pct = 0
    lines.push(
      `${pad(r.label, 12)}${pad(String(r.tokens), 10)}${pad(pct.toFixed(1) + '%', 10)}${r.note}`
    )
  }
  lines.push('-'.repeat(64))
  // 练习 4（续）：窗口占用率 = 合计 / window，用两位小数打印。
  const occupancy = 0
  lines.push(
    `${pad('合计', 12)}${pad(String(p.total), 10)}${pad('100.0%', 10)}窗口占用 ${occupancy.toFixed(2)}%（上限 ${window}）`
  )

  const biggest = [...p.rows].sort((a, b) => b.tokens - a.tokens)[0]
  lines.push('')
  lines.push(
    `最大的一块是「${biggest.label}」，占 ${p.total === 0 ? 0 : ((biggest.tokens / p.total) * 100).toFixed(1)}%。`
  )
  return lines.join('\n')
}

async function main() {
  const tools = loadTools(TOOL_COUNT)
  const buckets = splitContext(SYSTEM_PROMPT, tools, MESSAGES)
  const profile = IS_MOCK ? profileOffline(buckets) : await profileRemote(buckets)
  console.log(renderProfile(profile, WINDOW))

  if (IS_MOCK) {
    console.log('')
    console.log('离线模式：以上数字来自本地估算器。去掉 MOCK=1 并配置 ANTHROPIC_API_KEY，')
    console.log('就会改用计数接口做差分计数，把两次结果相减即可量出估算器的误差。')
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
