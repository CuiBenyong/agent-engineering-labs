// 跨集一致性检查：把「看起来像同一部剧」变成五条可判定的检查项。
//
// 判据全部只看提示词与档案，不看画面——画面好不好是 D11 的机器审片，
// 这里查的是「输入有没有漂」。输入不漂，输出才有可能不漂。

import { WORLD, imagePrompt, type EpisodePlan, type World } from './world.js'

export type Check = { id: string; label: string; pass: boolean; detail: string }

export function checkConsistency(world: World, season: EpisodePlan[]): Check[] {
  const checks: Check[] = []
  const known = new Set(world.cast.map((c) => c.id))

  const unknown = season.flatMap((e) =>
    e.shots.flatMap((s) =>
      s.characters.filter((c) => !known.has(c)).map((c) => `E${e.n}/${s.id}:${c}`)
    )
  )
  checks.push({
    id: 'cast-closed',
    label: '每集出场角色都在世界观档案里',
    pass: unknown.length === 0,
    detail:
      unknown.length === 0
        ? `${known.size} 个角色，五集共 ${season.flatMap((e) => e.shots).length} 镜，没有档案外的人物`
        : `档案外的人物：${unknown.join('、')}`,
  })

  // 音色是最容易漂的一项：同一个人在第三集换了嗓子，观众立刻察觉。
  const voices = new Map<string, Set<string>>()
  for (const c of world.cast) voices.set(c.id, new Set([c.voiceId]))
  const driftedVoice = [...voices.entries()].filter(([, v]) => v.size > 1).map(([k]) => k)
  checks.push({
    id: 'voice-stable',
    label: '同一角色的音色跨集不变',
    pass: driftedVoice.length === 0,
    detail:
      driftedVoice.length === 0
        ? world.cast.map((c) => `${c.name}=${c.voiceId}`).join('，')
        : `音色发生漂移：${driftedVoice.join('、')}`,
  })

  // 外貌描述必须逐字来自档案，不能在某一集里"顺手补两个词"。
  const appearanceMisses: string[] = []
  for (const e of season) {
    for (const s of e.shots) {
      const prompt = imagePrompt(world, s)
      for (const id of s.characters) {
        const c = world.cast.find((x) => x.id === id)
        if (c && !prompt.includes(c.appearance)) appearanceMisses.push(`E${e.n}/${s.id}:${c.name}`)
      }
    }
  }
  checks.push({
    id: 'appearance-verbatim',
    label: '角色外貌描述逐字来自档案',
    pass: appearanceMisses.length === 0,
    detail:
      appearanceMisses.length === 0
        ? '所有提示词里的外貌片段与档案逐字一致'
        : `没对上的：${appearanceMisses.join('、')}`,
  })

  const styleMisses: string[] = []
  for (const e of season) {
    for (const s of e.shots) {
      const prompt = imagePrompt(world, s)
      const missing = world.styleTokens.filter((t) => !prompt.includes(t))
      if (missing.length) styleMisses.push(`E${e.n}/${s.id} 缺 ${missing.join('/')}`)
    }
  }
  checks.push({
    id: 'style-tokens',
    label: '风格词每一镜都带上了',
    pass: styleMisses.length === 0,
    detail:
      styleMisses.length === 0 ? `风格词：${world.styleTokens.join('、')}` : styleMisses.join('；'),
  })

  // 集间钩子：第 N 集的 hook 必须是第 N+1 集的 pickUp，否则观众追不下去。
  const brokenHooks: string[] = []
  for (let i = 0; i < season.length - 1; i += 1) {
    const cur = season[i]
    const next = season[i + 1]
    if (!cur || !next) continue
    if (next.pickUp !== cur.hook) brokenHooks.push(`E${cur.n} → E${next.n}`)
  }
  checks.push({
    id: 'hook-chain',
    label: '集间钩子首尾相接',
    pass: brokenHooks.length === 0,
    detail:
      brokenHooks.length === 0
        ? season
            .slice(0, -1)
            .map((e) => `E${e.n}→E${e.n + 1}`)
            .join(' ')
        : `断链：${brokenHooks.join('、')}`,
  })

  return checks
}

export const DEFAULT_WORLD = WORLD
