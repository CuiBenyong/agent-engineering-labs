import type { Case } from './cases.js'
import { TARGET, type SkillMeta } from './catalog.js'

/**
 * 把描述切成「触发段」与「边界段」。
 * 边界段从第一处「只负责 / 不负责 / 不判断」开始——那一句之后写的是「它不管什么」。
 * 这个切分不是规范定义的，是我们为了让离线模拟能体现边界句的价值而做的近似。
 */
export function splitDescription(description: string): { trigger: string; boundary: string } {
  const idx = ['只负责', '不负责', '不判断']
    .map((k) => description.indexOf(k))
    .filter((i) => i >= 0)
  if (idx.length === 0) return { trigger: description, boundary: '' }
  const cut = Math.min(...idx)
  return { trigger: description.slice(0, cut), boundary: description.slice(cut) }
}

/**
 * 客户端在发现阶段看到的那份目录：每个 skill 只有名字与描述，没有正文。
 * 真模型分支会把这段文本原样发出去。
 */
export function buildJudgePrompt(skills: SkillMeta[], query: string): string {
  const catalog = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
  return [
    '下面是可用技能的清单，每条只有名字与描述。',
    catalog,
    '',
    `用户说：${query}`,
    '',
    '只回答一个技能的名字；如果没有任何一个明显适用，回答 none。不要解释。',
  ].join('\n')
}

/** 离线模拟：按意图信号给每个 skill 打分。触发段命中加一分，边界段命中减两分。 */
function mockScore(skill: SkillMeta, signals: string[]): number {
  const { trigger, boundary } = splitDescription(skill.description)
  let score = 0
  for (const s of signals) {
    if (trigger.includes(s)) score += 1
    if (boundary.includes(s)) score -= 2 // 边界句的作用就是把这类请求推开
  }
  return score
}

async function callModel(prompt: string): Promise<string> {
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
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
      max_tokens: 32,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { content: Array<{ type: string; text?: string }> }
  return json.content.find((c) => c.type === 'text')?.text ?? ''
}

/** 跑一次，返回被测 skill 有没有被选中。run 是第几次，用来模拟模型判断的不确定性。 */
export async function judgeOnce(skills: SkillMeta[], c: Case, run: number): Promise<boolean> {
  if (process.env.MOCK === '1') {
    const scored = skills.map((s) => ({ name: s.name, score: mockScore(s, c.signals) }))
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a))
    if (best.score <= 0 || best.name !== TARGET) return false
    // 分数为 1 的是「勉强命中」，让它三次里中两次，模拟真模型的抖动
    return best.score >= 2 || run !== 1
  }
  const answer = await callModel(buildJudgePrompt(skills, c.query))
  return answer.trim().toLowerCase().startsWith(TARGET)
}

/** 跑 runs 次取触发率。跑一次就下结论，是这套评测里最常见的错误。 */
export async function triggerRate(skills: SkillMeta[], c: Case, runs = 3): Promise<number> {
  let hits = 0
  for (let run = 0; run < runs; run++) if (await judgeOnce(skills, c, run)) hits++
  return hits / runs
}
