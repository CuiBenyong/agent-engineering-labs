// D4 实验（starter）：压缩策略
// 触发判据 → 切成「折叠段 + 保留段」→ 生成三段式摘要 → 关键事实存活检查。
//
// 唯一的网络出口是 summarize()：MOCK=1 时走本地抽取式摘要，形状与模型输出一致，
// 触发判据、切分、拼接、检查这几步在离线下也是真跑的。
//
// 四个练习点见下面的「练习 N」注释。现在直接跑 MOCK=1 pnpm start 是能跑通的，
// 但你会看到：不管会话多短都会压缩、最近几轮原文一条都没留下、
// 关键事实存活检查一条都没打印——三个都是「还没做完」的信号。

import 'dotenv/config'
import { CONVERSATION, KEY_FACTS, type Turn } from './fixture.js'
import { estimateTokens } from './tokens.js'

const WINDOW = Number(process.env.WINDOW ?? 3000)
const THRESHOLD = Number(process.env.THRESHOLD ?? 0.6)
const KEEP_TURNS = Number(process.env.KEEP_TURNS ?? 6)
const MODEL = process.env.MODEL ?? 'claude-sonnet-5'
const IS_MOCK = process.env.MOCK === '1'

function turnsToText(turns: Turn[]): string {
  return turns.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`).join('\n')
}

/**
 * 触发判据：占用率达到阈值才压缩。
 * 为什么不是「每 N 轮压一次」——轮数和 token 数不成正比，
 * 一次工具返回可以顶得上二十轮闲聊。要盯的是窗口占用，不是回合数。
 */
export function shouldCompact(turns: Turn[], window: number, threshold: number): boolean {
  // 练习 1：按窗口占用率判断该不该压缩。
  // 提示：estimateTokens(turnsToText(turns)) / window 达到 threshold 才返回 true。
  // 现在的实现无条件压缩，会把只说了两句话的会话也压一遍。
  void turns
  void window
  void threshold
  return true
}

/**
 * 切分：最近 keepTurns 轮留原文，更早的折叠去做摘要。
 * 最近几轮必须逐字保留——正在进行的那件事一旦被摘要，模型会立刻失去指代对象。
 */
export function splitKeepAndFold(turns: Turn[], keepTurns: number): { fold: Turn[]; keep: Turn[] } {
  // 练习 2：最近 keepTurns 轮留原文，更早的折叠去做摘要。
  // 提示：算出切分下标，前半段进 fold，后半段进 keep。
  // 现在的实现把整段会话都折叠掉了，正在进行的那件事会连指代对象一起消失。
  void keepTurns
  return { fold: turns, keep: [] }
}

export function buildSummaryPrompt(fold: Turn[]): string {
  // 练习 3：把摘要提示词写成三段式。
  // 提示：分成「已定结论 / 待办事项 / 硬约束」三段，并要求逐字保留订单号、金额、
  // 单号、政策条目编号这类原文标识——摘要最容易丢的就是这些标识符。
  // 这一条要去掉 MOCK=1 才看得出差别：离线摘要是本地抽取的，不读这段提示词。
  return `请总结下面的对话：\n${turnsToText(fold)}`
}

/** 唯一的网络出口。MOCK=1 时一行真实请求都不发。 */
async function summarize(fold: Turn[]): Promise<string> {
  if (IS_MOCK) return extractiveSummary(fold)

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
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildSummaryPrompt(fold) }],
    }),
  })
  if (!res.ok) throw new Error(`模型接口返回 ${res.status}：${await res.text()}`)
  const json = (await res.json()) as { content: { type: string; text?: string }[] }
  return json.content.map((b) => b.text ?? '').join('')
}

/**
 * 离线摘要：抽取式。按关键词把句子分进三段，形状与模型输出一致。
 * 它当然不如模型聪明——正因为不聪明，才能让「压缩会丢东西」这件事在离线下也看得见：
 * 没被关键词命中的句子就是会消失，把 KEEP_TURNS 调小就能亲眼看到某条事实不见了。
 */
function extractiveSummary(fold: Turn[]): string {
  const sentences = fold.flatMap((t) =>
    t.text
      .split(/[。！？\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      // 例行的重复往返（「第 N 轮回复：包裹仍在运输途中……」）没有增量信息，
      // 直接排除。摘要要留的是信号，不是把噪声也浓缩一遍。
      .filter((s) => !/^第 \d+ 轮/.test(s))
      .map((s) => ({ role: t.role, s }))
  )
  const pick = (keywords: string[]) =>
    sentences
      .filter(({ s }) => keywords.some((k) => s.includes(k)))
      .map(({ s }) => `- ${s}。`)
      .slice(0, 6)

  const decided = pick(['确认', '已经'])
  const todo = pick(['工单', '预计', '时效'])
  const constraints = pick(['不能', '必须', '政策', '承担'])

  return [
    '已定结论：',
    ...(decided.length ? decided : ['- （无）']),
    '待办事项：',
    ...(todo.length ? todo : ['- （无）']),
    '硬约束：',
    ...(constraints.length ? constraints : ['- （无）']),
  ].join('\n')
}

export function checkRetention(context: string): { label: string; ok: boolean }[] {
  // 练习 4：逐条核对 KEY_FACTS 里的事实还在不在压缩后的上下文里。
  // 现在返回空数组，于是脚本每次都会宣布「一条没丢」——
  // 一个不检查的检查函数比没有检查更危险，因为它会让你放心地把阈值越调越激进。
  void context
  return []
}

async function main() {
  const before = estimateTokens(turnsToText(CONVERSATION))
  const occupancy = (before / WINDOW) * 100

  console.log(
    `会话共 ${CONVERSATION.length} 轮，约 ${before} token，窗口 ${WINDOW}，占用 ${occupancy.toFixed(1)}%`
  )
  console.log(`触发阈值 ${(THRESHOLD * 100).toFixed(0)}%，保留最近 ${KEEP_TURNS} 轮原文`)
  console.log('')

  if (!shouldCompact(CONVERSATION, WINDOW, THRESHOLD)) {
    console.log('未达到触发阈值，不压缩。把 THRESHOLD 调低再试一次。')
    return
  }

  const { fold, keep } = splitKeepAndFold(CONVERSATION, KEEP_TURNS)
  const summary = await summarize(fold)
  const compacted = `【前情摘要】\n${summary}\n\n【最近 ${keep.length} 轮原文】\n${turnsToText(keep)}`
  const after = estimateTokens(compacted)

  console.log('压缩后的上下文：')
  console.log('-'.repeat(72))
  console.log(compacted)
  console.log('-'.repeat(72))
  console.log('')
  console.log(
    `折叠 ${fold.length} 轮、保留 ${keep.length} 轮：${before} token → ${after} token，压缩率 ${(((before - after) / before) * 100).toFixed(1)}%`
  )
  console.log('')

  console.log('关键事实存活检查：')
  const checks = checkRetention(compacted)
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.label}`)
  const failed = checks.filter((c) => !c.ok).length
  console.log('')
  if (failed === 0) {
    console.log(`${checks.length} 条关键事实一条没丢，这次压缩是安全的。`)
  } else {
    console.log(
      `丢了 ${failed} 条关键事实——压过头了，把 KEEP_TURNS 调大，或者把这几条写进摘要提示词的必留清单。`
    )
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
