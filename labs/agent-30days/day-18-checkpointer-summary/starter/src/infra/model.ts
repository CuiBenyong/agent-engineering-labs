// 唯一的网络出口。三种用途共用一个函数，靠 intent 区分：
//   plan      把一句请求拆成 1–3 件子任务（沿用 D17 的做法，今天不是重点）
//   compose   Executor 把工具观测写成一段结论
//   summarize 摘要节点把早期消息压成一段摘要
// MOCK=1 时真实分支一行都不执行，但假回复必须**随输入变化**——
// 换一批早期消息，摘要的内容就会跟着变，否则「历史保真」这件事在离线状态下根本看不出来。

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export type Intent = 'plan' | 'compose' | 'summarize'

const SYSTEM: Record<Intent, string> = {
  plan: '你是任务规划者。从给定的子任务类型清单里挑出这条请求真正需要的几项，最多 3 项，每行只输出一个 kind，不要解释。',
  compose: '你是电商客服的执行者。根据工具观测写出一段简短结论，只用观测里出现过的事实。',
  summarize:
    '你是对话归档员。把早期对话压成一段摘要，必须逐条保留「是谁说的、在第几条说的」这两样信息，以及用户声明过的事实与约束；不要复述寒暄。',
}

// ---------------------------------------------------------------------------
// 离线实现：三种 intent 各一段，都从 prompt 里解析出参数，行为与真实模型一致。
// ---------------------------------------------------------------------------

function offlinePlan(prompt: string): string {
  const request = prompt.match(/用户请求：(.*)/)?.[1] ?? ''
  const picked: string[] = []
  for (const line of prompt.split('\n')) {
    const [kind, pattern] = line.split(' :: ')
    if (!pattern) continue
    if (new RegExp(pattern).test(request)) picked.push(kind.trim())
  }
  return picked.slice(0, 3).join('\n')
}

function offlineCompose(prompt: string): string {
  const goal = prompt.match(/子任务目标：(.*)/)?.[1] ?? ''
  const facts = prompt
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2))
  return `${goal}：${facts.join('；')}`
}

/**
 * 离线摘要。它刻意做成「保真」的样子：先按角色统计谁说了几条，
 * 再把带 # 序号的关键事实原样摘出来——因为今天要验证的正是「摘要没有把发言人抹平」。
 * 换一批早期消息，下面每一段都会变。
 */
function offlineSummarize(prompt: string): string {
  const previous = prompt.match(/已有摘要（要合并进新摘要，不要丢）：(.*)/)?.[1]
  const lines = prompt.split('\n').filter((l) => /^#\d+ /.test(l))
  const byRole = new Map<string, number[]>()
  for (const line of lines) {
    const [, index, role] = line.match(/^#(\d+) (\w+):/) ?? []
    if (!role) continue
    byRole.set(role, [...(byRole.get(role) ?? []), Number(index)])
  }
  const roster = [...byRole.entries()]
    .map(([role, at]) => `${role} 共 ${at.length} 条（#${at[0]}–#${at[at.length - 1]}）`)
    .join('，')

  // 「关键事实」的口径：带订单号、金额、日期、规则结论的行，原样留下来不改写。
  const facts = lines
    .filter((l) => /SO\d{8}|\d+ 元|\d+ 天|不可|可退|已出库|待发货/.test(l))
    .map((l) => l.replace(/^#(\d+) (\w+): /, '#$1($2) '))
    .slice(0, 6)

  const head = previous ? `${previous}；继而：` : ''
  return `${head}早期对话 ${lines.length} 条，${roster}。关键事实（保留原始条号与发言人）：${facts.join('｜')}`
}

const OFFLINE: Record<Intent, (prompt: string) => string> = {
  plan: offlinePlan,
  compose: offlineCompose,
  summarize: offlineSummarize,
}

/** 只为教学：数一数这一段跑了几次模型。恢复时它必须**不**把已经跑过的节点再跑一遍。 */
let calls = 0
export function modelCallCount(): number {
  return calls
}
export function resetModelCallCount(): void {
  calls = 0
}

/** 调一次模型。MOCK 的判断放在最前面，离线时真实分支完全不会被执行。 */
export async function callModel(intent: Intent, prompt: string): Promise<string> {
  calls += 1
  if (process.env.MOCK === '1') {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return OFFLINE[intent](prompt)
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM[intent] },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`)

  const body = (await res.json()) as { choices: { message: { content: string } }[] }
  return body.choices[0]?.message?.content ?? ''
}
