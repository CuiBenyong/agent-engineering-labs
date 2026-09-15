// 唯一的网络出口。六种用途共用一个函数：route / plan / compose / review 是 D16、D17 已有的，
// smalltalk 是兜底那位，judge 是今天新增的评分员。MOCK=1 时真实分支一行都不执行，但假回复
// 必须**随输入变化**——尤其是 judge：换产出、换评分提示词、换 judge 模型，分数都要跟着变，
// 否则今天要看的三种失效模式一个都看不到。
// 这个文件同时是**计量点**：每次调用记一次 token 与耗时，成本面板的原始数据全从这里来。

import { recordModelCall } from '../shared/observe'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export type Intent = 'route' | 'plan' | 'compose' | 'review' | 'smalltalk' | 'judge'

/** 本课固定的两个模型 id。judge 用哪一个是今天的正题，所以它必须是显式参数。 */
export const CHAT_MODEL = 'openai/gpt-4o-mini'
export const ALT_JUDGE_MODEL = 'anthropic/claude-3.5-haiku'

const SYSTEM: Record<Intent, string> = {
  route: '你是分诊台。只输出一个 JSON：route、confidence、routingReason，不要解释。',
  plan: '你是任务规划者。从清单里挑出这条请求真正需要的几项，最多 3 项，每行一个 kind。',
  compose:
    '你是电商客服的执行者。根据工具观测写出一段简短结论，只用观测里出现过的事实；如果目标里带了评审意见，针对它补一句结论。',
  review: '你是评审者。产出里确实出现了验收要求那句话才回 PASS，否则回 REDO 加上具体缺了什么。',
  smalltalk: '你是兜底客服。信息不足时先追问缺的关键信息，不要猜。',
  judge: '你是评分员。严格按给定的评分标准打 1 到 5 分，输出 SCORE 与 REASON 两行。',
}

// 提示词是有版本的资产。今天要演示「改坏一条提示词，通过率会掉多少、掉在哪几条上」，
// broken 版只做一件事：把 compose 那句「针对评审意见补一句结论」删掉。
export type PromptVersion = 'v2' | 'broken'
let promptVersion: PromptVersion = 'v2'
export const setPromptVersion = (v: PromptVersion): void => void (promptVersion = v)

// --------------------------------- 离线实现 ---------------------------------

function offlineRoute(prompt: string): string {
  const text = prompt.match(/用户说：(.*)/)?.[1] ?? ''
  const decide = (): [string, number, string] => {
    if (/上次那个|那个事/.test(text)) return ['order_lookup', 0.42, '提到那个事但没说是哪一单']
    if (/会员等级|积分/.test(text)) return ['membership_agent', 0.81, '像是会员权益问题']
    if (/退款|退货|退钱/.test(text)) return ['refund_draft', 0.9, '用户明确提出退款诉求']
    if (/SO\d{8}|订单|物流|快递|状态|发票|开票|破损|理赔|收件/.test(text))
      return ['order_lookup', 0.88, '在问某一单的状态或后续处理']
    return ['smalltalk', 0.75, '没有具体业务诉求，先接住话头']
  }
  const [route, confidence, routingReason] = decide()
  return JSON.stringify({ route, confidence, routingReason })
}

function offlinePlan(prompt: string): string {
  const request = prompt.match(/用户请求：(.*)/)?.[1] ?? ''
  const picked = prompt
    .split('\n')
    .map((line) => line.split(' :: '))
    .filter(([, pattern]) => pattern && new RegExp(pattern).test(request))
    .map(([kind]) => kind.trim())
  return picked.slice(0, 3).join('\n')
}

function offlineCompose(prompt: string): string {
  const goal = prompt.match(/子任务目标：(.*)/)?.[1] ?? ''
  const base = prompt
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2))
    .join('；')
  const feedback = goal.match(/评审意见：(.*)$/)?.[1]
  // broken 版少的正是这一句：拿到评审意见也不补结论，于是永远被打回，最后降级
  if (!feedback || promptVersion === 'broken') return base
  const conclusion = /7 天内可退/.test(base)
    ? '退款结论：符合未拆封 7 天内可退，建议全额退还实付金额'
    : /预计送达/.test(base)
      ? '配送结论：按当前轨迹可如期送达'
      : '暂无更多可查信息，需转人工跟进'
  return `${base}；针对评审意见补充 → ${conclusion}`
}

function offlineReview(prompt: string): string {
  const want = prompt.match(/验收要求：(.*)/)?.[1]?.trim() ?? ''
  const output = prompt.match(/产出：([\s\S]*)$/)?.[1] ?? ''
  if (want && output.includes(want)) return 'PASS'
  return `REDO 产出里没有写明${want}，请补上`
}

const offlineSmalltalk = (prompt: string): string =>
  /谢谢|不错|挺好|感谢/.test(prompt.match(/用户说：(.*)/)?.[1] ?? '')
    ? '不客气，很高兴帮到您，还有别的可以帮您看看的吗。'
    : '我这边还不确定您指的是哪一单，请补充订单号，或者告诉我想办理的业务。'

/**
 * 离线 judge。它刻意把真实 judge 的三种失效模式实现出来，因为这三种正是今天要教的：
 *   1. 长度偏好：v1 那套「整体印象」提示词只看篇幅，灌水就能加分；
 *   2. 同源偏差：judge 与被评者是同一个模型时给自己加一分；
 *   3. 版本漂移：v1 与 v2 对同一份产出给出的分数完全不同，跨版本不可比。
 * 真实模型的偏差比这里小、也带噪声，但方向一致——这里放大它，是为了让现象一次自检就看得见。
 */
function offlineJudge(prompt: string): string {
  const field = (key: string): string => prompt.match(new RegExp(`${key}: (.*)`))?.[1]?.trim() ?? ''
  const checklist = field('CHECKLIST').split('|').filter(Boolean)
  const output = prompt.match(/OUTPUT:\n([\s\S]*)$/)?.[1] ?? ''

  let score: number
  let reason: string
  if (field('RUBRIC') === 'v1' || checklist.length === 0) {
    // v1：没有可核对的清单，只能凭「读起来充不充实」——这就是长度偏好的来源
    score = output.length < 60 ? 2 : output.length < 150 ? 3 : output.length < 300 ? 4 : 5
    reason = `整体印象：篇幅 ${output.length} 字，信息量看起来${score >= 4 ? '充分' : '偏薄'}`
  } else {
    const hit = checklist.filter((item) => output.includes(item))
    const miss = checklist.filter((item) => !output.includes(item))
    score = 1 + Math.round((4 * hit.length) / checklist.length)
    reason = `逐条核对：命中 ${hit.length}/${checklist.length}${miss.length > 0 ? `，缺 ${miss.join('、')}` : ''}`
  }
  if (field('JUDGE_MODEL') !== '' && field('JUDGE_MODEL') === field('TARGET_MODEL')) {
    score = Math.min(5, score + 1)
    reason += '（同源加分）'
  }
  return `SCORE: ${score}\nREASON: ${reason}`
}

const OFFLINE: Record<Intent, (prompt: string) => string> = {
  route: offlineRoute,
  plan: offlinePlan,
  compose: offlineCompose,
  review: offlineReview,
  smalltalk: offlineSmalltalk,
  judge: offlineJudge,
}

// ----------- 计量：字符数按 D6 的口径 1:1 当 token 用（保守高估） -----------

export interface IntentUsage {
  calls: number
  promptTokens: number
  completionTokens: number
}

const usage = new Map<Intent, IntentUsage>()
export const usageOf = (i: Intent): IntentUsage =>
  usage.get(i) ?? { calls: 0, promptTokens: 0, completionTokens: 0 }
export const resetUsage = (): void => usage.clear()

/** 调一次模型。MOCK 的判断放在最前面，离线时真实分支完全不会被执行。 */
export async function callModel(
  intent: Intent,
  prompt: string,
  model = CHAT_MODEL
): Promise<string> {
  const startMs = performance.now()
  const text = await invoke(intent, prompt, model)
  const row = usageOf(intent)
  usage.set(intent, {
    calls: row.calls + 1,
    promptTokens: row.promptTokens + prompt.length,
    completionTokens: row.completionTokens + text.length,
  })
  // 每一次模型调用都在 trace 里留一个 span：成本面板与调用树用的是同一份原始数据
  recordModelCall({
    intent,
    model,
    promptTokens: prompt.length,
    completionTokens: text.length,
    startMs,
    endMs: performance.now(),
  })
  return text
}

async function invoke(intent: Intent, prompt: string, model: string): Promise<string> {
  if (process.env.MOCK === '1') {
    await new Promise((resolve) => setTimeout(resolve, 4))
    return OFFLINE[intent](prompt)
  }
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
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
