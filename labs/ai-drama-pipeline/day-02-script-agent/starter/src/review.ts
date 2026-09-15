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
  void characters

  // D4 的视频提示词要吃 camera，空着等于让模型自由发挥
  for (const s of ep.shots) {
    if (!s.camera.trim())
      issues.push(`[camera] ${s.id} 缺运镜描述，第 4 天生成视频时没有东西可写进提示词`)
  }

  // 练习 1：把另外四条硬伤补上。格式照第一条，开头方括号里的代码是给写手看的分类。
  //   [duration] 每镜时长必须在 3 到 8 秒之间（视频接口按秒计费，单镜太长既贵又难控）
  //   [dialogue] 单条台词不超过 25 字（第 5 天配音时长会按字数撑爆这一镜）
  //   [coverage] 人物卡里的人必须至少出场一次（不出场的角色，定妆图就白生成了）
  //   [pacing]   全集总时长在 45 到 90 秒之间
  //   提示：现在跑起来第 1 轮只有 3 条硬伤，s03 的 12 秒和 s05 的 40 字台词一直没人管，
  //        它们会原样进 episode-1.json，第 4、5 天才会爆。

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

  // 练习 2：把最终分算成「硬伤七成、软分三成」的加权分。
  //   hardScore = 100 减去 硬伤条数 乘 PENALTY，不低于 0；
  //   score = 四舍五入(hardScore * 0.7 + softScore * 0.3)。
  //   现在直接用模型给的软分，硬伤一条都不扣——所以第一轮就能「达标」，
  //   而 checkHard 查出来的问题原样留在定稿里。机器能判定的东西不该被模型的好评盖过去。
  void PENALTY
  const score = softScore
  return { score, hard, soft }
}
