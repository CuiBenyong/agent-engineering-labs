// 唯一的网络出口。三种用途共用一个函数，靠 intent 区分：
//   plan    Planner 把请求拆成子任务
//   compose Executor 把工具观测写成一段结论
//   review  Critic 判这份产出合不合格
// MOCK=1 时真实分支一行都不执行，但假回复必须**随输入变化**——
// 换个订单号、换个诉求、被打回一次，三种回复都会跟着变，否则今天的现象一个都看不到。

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export type Intent = 'plan' | 'compose' | 'review'

const SYSTEM: Record<Intent, string> = {
  plan: '你是任务规划者。从给定的子任务类型清单里挑出这条请求真正需要的几项，最多 3 项，每行只输出一个 kind，不要解释。',
  compose:
    '你是电商客服的执行者。根据工具观测写出一段简短结论，只用观测里出现过的事实；如果目标里带了评审意见，针对它补一句结论。',
  review:
    '你是评审者。只有产出里确实出现了验收要求那句话时才回 PASS；否则回一行 REDO 加上具体缺了什么，不要回「不合格」这种没法照着改的理由。',
}

// ---------------------------------------------------------------------------
// 离线实现：三种 intent 各一段。它们都从 prompt 里解析出参数，行为与真实模型一致。
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
  const base = facts.join('；')
  const feedback = goal.match(/评审意见：(.*)$/)?.[1]
  if (!feedback) return base
  // 被打回之后，执行者会针对评审意见补一段结论——但它只能用工具真的查到的东西补。
  // 查不到的（比如还没分配的工单号）它补不出来，于是会被一直打回，直到撞上重试上限。
  return `${base}；针对评审意见补充 → ${conclude(base)}`
}

function conclude(base: string): string {
  if (/7 天内可退/.test(base)) return '退款结论：符合未拆封 7 天内可退，建议全额退还实付金额'
  if (/预计送达/.test(base)) return '配送结论：按当前轨迹可如期送达'
  return '暂无更多可查信息，需转人工跟进'
}

function offlineReview(prompt: string): string {
  const want = prompt.match(/验收要求：(.*)/)?.[1]?.trim() ?? ''
  const output = prompt.match(/产出：([\s\S]*)$/)?.[1] ?? ''
  if (want && output.includes(want)) return 'PASS'
  // 打回必须带具体理由：只说「不合格」，执行者重做一次还是同样的产出。
  return `REDO 产出里没有写明${want}，请补上`
}

const OFFLINE: Record<Intent, (prompt: string) => string> = {
  plan: offlinePlan,
  compose: offlineCompose,
  review: offlineReview,
}

/** 调一次模型。MOCK 的判断放在最前面，离线时真实分支完全不会被执行。 */
export async function callModel(intent: Intent, prompt: string): Promise<string> {
  if (process.env.MOCK === '1') {
    await new Promise((resolve) => setTimeout(resolve, 10))
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
