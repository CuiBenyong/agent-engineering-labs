import type { Case } from './cases.js'
import { TARGET, type SkillMeta } from './catalog.js'

/**
 * 把描述切成「触发段」与「边界段」。
 * 边界段从第一处「只负责 / 不负责 / 不判断」开始——那一句之后写的是「它不管什么」。
 * 这个切分不是规范定义的，是我们为了让离线模拟能体现边界句的价值而做的近似。
 */
export function splitDescription(description: string): { trigger: string; boundary: string } {
  // 练习 1：从第一处「只负责 / 不负责 / 不判断」把描述切成两段。
  // 提示：三个关键词都要找，取下标最小的那个；一个都没有时整段都算触发段。
  // 现在的默认实现把边界段当成空的 —— 跑起来你会看到「不该触发的却触发了」。
  return { trigger: description, boundary: '' }
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
  // 练习 2：逐个信号打分。触发段命中加一分；边界段命中减两分（边界句的作用就是把这类请求推开）。
  // 提示：分数是相对的，只要「命中触发段」比「命中边界段」更值钱就行。
  void trigger
  void boundary
  void signals
  return 0 // 默认全 0，所有 skill 都选不中，正例会全军覆没
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
  // 练习 3：跑 runs 次，返回命中次数除以总次数。
  // 现在只跑了一次，触发率永远是 0 或 1 —— 那正是本课点名批评的做法。
  void runs
  return (await judgeOnce(skills, c, 0)) ? 1 : 0
}
