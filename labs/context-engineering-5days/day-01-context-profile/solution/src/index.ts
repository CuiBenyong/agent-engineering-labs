// D1 实验（solution）：上下文用量剖面脚本
// 把一次会话的请求体拆成系统提示 / 工具定义 / 对话历史 / 工具结果四块，分别计数并输出占比表。
//
// 离线（MOCK=1）：四块都用本地估算器计数，零网络、零 key。
// 在线：用 Claude 的 token 计数接口做「差分计数」——接口只肯告诉你一个总数，
//       想知道某一块占多少，就用「带这一块的请求」减去「不带这一块的请求」。

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
 * 把一次请求拆成四块。
 * 关键判断：工具结果虽然写在 user 消息里，但它不是「用户说的话」——
 * 它是工具吐回来的数据，增长方式、可裁剪程度都和对话历史完全不同，必须单独算一块。
 */
export function splitContext(system: string, tools: Tool[], messages: Message[]): Buckets {
  const history: Message[] = []
  const toolResults: ToolResultEntry[] = []

  for (const msg of messages) {
    const kept: Block[] = []
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        toolResults.push({ tool_use_id: block.tool_use_id, content: block.content })
      } else {
        kept.push(block)
      }
    }
    if (kept.length > 0) history.push({ role: msg.role, content: kept })
  }

  return { system, tools, history, toolResults }
}

/**
 * 离线估算器：按字符类别粗算 token。
 * 汉字与全角标点大约 1 个字 1 个 token，ASCII 大约 3.5 个字符 1 个 token。
 * 这是个「够用就好」的近似，实验最后一步会用真实接口量出它的误差。
 */
export function estimateTokens(input: unknown): number {
  const text = typeof input === 'string' ? input : JSON.stringify(input)
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[　-〿一-鿿＀-￯]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.round(cjk + other / 3.5)
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
 * 差分计数：
 *   baseline      = 一个最小请求的开销（模板、角色标记等固定成本）
 *   系统提示      = count(system + 最小消息) - baseline
 *   工具定义      = count(tools  + 最小消息) - baseline
 *   历史 + 工具结果 = count(完整请求) - count(system + tools + 最小消息)
 * 最后一块接口拆不开（工具结果必须跟在对应的 tool_use 后面，单独发会被拒），
 * 所以按估算器算出的比例二次拆分，并在表里标出来这一步是估的。
 */
async function profileRemote(b: Buckets): Promise<Profile> {
  const baseline = await countRemote({ messages: DOT })
  const withSystem = await countRemote({ system: b.system, messages: DOT })
  const withBoth = await countRemote({ system: b.system, tools: b.tools, messages: DOT })
  const full = await countRemote({ system: b.system, tools: b.tools, messages: MESSAGES })

  const systemTokens = withSystem - baseline
  const toolTokens = withBoth - withSystem
  const messageTokens = full - withBoth

  const estHistory = estimateTokens(b.history)
  const estResults = estimateTokens(b.toolResults)
  const ratio = estHistory + estResults === 0 ? 0 : estHistory / (estHistory + estResults)
  const historyTokens = Math.round(messageTokens * ratio)

  return {
    source: '计数接口差分',
    total: full,
    rows: [
      { label: '基础开销', tokens: baseline, note: '空请求也要付的模板成本' },
      { label: '系统提示', tokens: systemTokens, note: '每一轮都重发' },
      { label: '工具定义', tokens: toolTokens, note: `${b.tools.length} 个工具` },
      { label: '对话历史', tokens: historyTokens, note: '按估算比例拆分' },
      {
        label: '工具结果',
        tokens: messageTokens - historyTokens,
        note: `${b.toolResults.length} 次工具返回，按估算比例拆分`,
      },
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
    const pct = p.total === 0 ? 0 : (r.tokens / p.total) * 100
    lines.push(
      `${pad(r.label, 12)}${pad(String(r.tokens), 10)}${pad(pct.toFixed(1) + '%', 10)}${r.note}`
    )
  }
  lines.push('-'.repeat(64))
  lines.push(
    `${pad('合计', 12)}${pad(String(p.total), 10)}${pad('100.0%', 10)}窗口占用 ${((p.total / window) * 100).toFixed(2)}%（上限 ${window}）`
  )

  const biggest = [...p.rows].sort((a, b) => b.tokens - a.tokens)[0]
  lines.push('')
  lines.push(
    `最大的一块是「${biggest.label}」，占 ${((biggest.tokens / p.total) * 100).toFixed(1)}%。`
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
