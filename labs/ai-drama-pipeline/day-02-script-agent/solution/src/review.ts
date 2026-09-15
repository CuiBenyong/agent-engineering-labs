// 评审角色：分两层。
// 硬伤（能被程序判定的）用代码查——不花钱、不会漏、结论稳定；
// 软伤（人物动机、开场钩子这类）才交给模型打分。
// 这条分界线是本天最重要的工程判断：能判定的绝不交给模型。

import type { Character } from './providers/index.js'
import type { TextProvider } from './providers/index.js'
import { extractJson, type Episode } from './schema.js'

/** 每条硬伤扣的分。5 条硬伤扣满 40 分，足以把稿子拦在阈值外。 */
export const PENALTY = 8
export const PASS_SCORE = Number(process.env.PASS_SCORE ?? 88)
export const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 4)

/** 硬伤代码。写手拿到的意见里带着它，所以修哪一类是可判定的。 */
export type HardCode = 'camera' | 'duration' | 'dialogue' | 'coverage' | 'pacing'

export type Review = { score: number; hard: string[]; soft: string[] }

/** 五条能被程序判定的规则。每一条都对应后面某一天的真实约束，不是凑数。 */
export function checkHard(ep: Episode, characters: Character[]): string[] {
  const issues: string[] = []
  const charIds = new Set(characters.map((c) => c.id))

  // D4 的视频提示词要吃 camera，空着等于让模型自由发挥
  for (const s of ep.shots) {
    if (!s.camera.trim())
      issues.push(`[camera] ${s.id} 缺运镜描述，第 4 天生成视频时没有东西可写进提示词`)
  }
  // 视频接口按秒计费，单镜太长既贵又难控
  for (const s of ep.shots) {
    if (s.durationSec < 3 || s.durationSec > 8) {
      issues.push(`[duration] ${s.id} 时长 ${s.durationSec} 秒超出 3 到 8 秒的区间`)
    }
  }
  // 台词太长，第 5 天配音时长会撑爆这一镜
  for (const s of ep.shots) {
    for (const d of s.dialogue) {
      if (d.text.length > 25) {
        issues.push(`[dialogue] ${s.id} 有一句 ${d.text.length} 字的台词，超过 25 字上限`)
      }
    }
  }
  // 人物卡里的人得真的出场，否则定妆图白生成
  for (const c of characters) {
    if (!ep.shots.some((s) => s.characters.includes(c.id))) {
      issues.push(`[coverage] 人物 ${c.name} 一次都没出场`)
    }
    if (!charIds.has(c.id)) issues.push(`[coverage] 人物 ${c.name} 缺 id`)
  }
  // 一集的总时长节奏
  const total = ep.shots.reduce((s, x) => s + x.durationSec, 0)
  if (total < 45 || total > 90) issues.push(`[pacing] 全集 ${total} 秒，超出 45 到 90 秒的区间`)

  return issues
}

const SOFT_PROMPT = `你是短剧剧本评审。只评价程序判不了的部分：开场三秒有没有钩子、人物动机是否成立、结尾有没有留住下一集的理由。
不要评价字段格式、时长、镜号，那些由程序检查。
只输出 JSON：{"score": 0 到 100 的整数, "issues": ["一句话意见", ...]}`

export async function review(
  text: TextProvider,
  ep: Episode,
  characters: Character[]
): Promise<Review> {
  const hard = checkHard(ep, characters)

  const raw = await text.complete({
    system: SOFT_PROMPT,
    user: `请评审下面这一集的分镜数据。\n\n\`\`\`json\n${JSON.stringify(ep, null, 2)}\n\`\`\``,
    temperature: 0.2,
  })
  const parsed = extractJson(raw.text) as { score?: unknown; issues?: unknown }
  const softScore =
    typeof parsed.score === 'number' && parsed.score >= 0 && parsed.score <= 100 ? parsed.score : 60
  const soft = Array.isArray(parsed.issues) ? parsed.issues.map(String) : []

  // 硬伤是一票否决式的扣分，软分只占三成——机器能判定的东西不该被模型的好评盖过去。
  const hardScore = Math.max(0, 100 - hard.length * PENALTY)
  const score = Math.round(hardScore * 0.7 + softScore * 0.3)
  return { score, hard, soft }
}
