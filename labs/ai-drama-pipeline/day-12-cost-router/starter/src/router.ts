// 分档路由：同一条业务代码，按档位换模型与规格。
// 路由只决定「用什么规格调」，不决定「调不调」——那是预算熔断的事。

import type { RateId } from './pricing.js'

export type Tier = 'draft' | 'final'

export type StagePlan = {
  /** 传给 provider 的 model id 用环境变量控制，路由这里只管规格与计价档 */
  videoResolution: string
  videoRateId: RateId
  /** 每镜时长上限，超过就截断——「时长」是三个可降级维度之一 */
  maxShotSeconds: number
  /** 参与生成的镜头数上限——第二个可降级维度 */
  maxShots: number
  /** 草稿档跳过定妆图，直接用文字描述当提示词 */
  characterSheets: boolean
  textModelHint: string
  ttsModelHint: string
  note: string
}

export const TIERS: Record<Tier, StagePlan> = {
  draft: {
    videoResolution: '512P',
    // 单价表里没有 512P 这一档，按规矩往贵了估：用 768P 的单价，宁可高估不要低估。
    videoRateId: 'video-768p',
    maxShotSeconds: 3,
    maxShots: 3,
    characterSheets: false,
    textModelHint: 'MiniMax-M2.7-highspeed',
    ttsModelHint: 'speech-2.8-turbo',
    note: '草稿档：只看叙事对不对，画质与时长都可以先凑合',
  },
  final: {
    videoResolution: '768P',
    videoRateId: 'video-768p',
    maxShotSeconds: 6,
    maxShots: 3,
    characterSheets: true,
    textModelHint: 'MiniMax-M3',
    ttsModelHint: 'speech-2.8-hd',
    note: '成片档：要发出去的那一版，画质与时长按分镜给的来',
  },
}

/** 三个可降级维度，按「读者最不容易察觉」到「最容易察觉」排序，依次施加。 */
export const DEGRADE_STEPS: { id: string; label: string; apply: (p: StagePlan) => StagePlan }[] = [
  {
    id: 'resolution',
    label: '降清晰度：768P → 512P',
    apply: (p) => ({ ...p, videoResolution: '512P' }),
  },
  {
    id: 'duration',
    label: '砍时长：每镜上限 6 秒 → 4 秒',
    apply: (p) => ({ ...p, maxShotSeconds: Math.min(p.maxShotSeconds, 4) }),
  },
  {
    id: 'shots',
    label: '砍镜头数：只保留前 2 镜',
    apply: (p) => ({ ...p, maxShots: Math.min(p.maxShots, 2) }),
  },
]

/**
 * 按预算自动降级：把降级步骤依次施加，直到预估花费落进上限。
 * 返回降到第几步、以及最终的执行计划。全都降完还是超，就交给调用方决定停不停。
 */
export function degradeToFit(
  plan: StagePlan,
  projectFor: (p: StagePlan) => number,
  limitCny: number
): { plan: StagePlan; applied: string[]; skipped: string[]; projected: number; fits: boolean } {
  // 练习 4：实现「先降级再跑」。
  //   依次遍历 DEGRADE_STEPS，只要当前预估还超 limitCny 就施加下一步；
  //   施加后如果预估没变小（这一步省不出钱），就记进 skipped 并跳过，别白降质量；
  //   最后返回降级后的计划、采纳与跳过的步骤、以及是否进得去预算。
  // 现在原样返回：阶段 ⑥ 会打印「一步都没降」，预算不够也照跑——这就是没做完的现象。
  void DEGRADE_STEPS
  const cur = plan
  const applied: string[] = []
  const skipped: string[] = []
  const projected = projectFor(cur)
  return { plan: cur, applied, skipped, projected, fits: projected <= limitCny }
}
