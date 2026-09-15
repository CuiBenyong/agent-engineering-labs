/**
 * 这是整个运行时**唯一的网络出口**：把目录和用户的话交给模型，让它选一个 skill。
 * 注意「选哪个」这件事是模型做的，不是运行时做的 —— 运行时不该自己做关键词匹配，
 * 那会把描述的语义判断退化成字符串命中。
 */
import { buildCatalog } from './catalog.js'
import type { ParsedSkill } from './parse.js'

export async function selectSkill(skills: ParsedSkill[], query: string): Promise<string | null> {
  if (skills.length === 0) return null

  if (process.env.MOCK === '1') {
    // 离线模拟：按描述里出现的意图词做一次朴素匹配，够看清流程即可。
    // 真模型的判断质量完全不是这个水平，去掉 MOCK=1 才算验过。
    const hit = skills.find((s) =>
      ['提交', '发布报告'].some((w) => query.includes(w) && s.description.includes(w))
    )
    return hit?.name ?? null
  }

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
      system: buildCatalog(skills),
      messages: [
        {
          role: 'user',
          content: `用户说：${query}\n\n只回答一个技能的 name；没有明显适用的就回答 none。不要解释。`,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { content: Array<{ type: string; text?: string }> }
  const answer = (json.content.find((c) => c.type === 'text')?.text ?? '').trim()
  return skills.some((s) => s.name === answer) ? answer : null
}
