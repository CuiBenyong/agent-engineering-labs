// 配音环节：音色分配、批量合成、时长回读。
// 一条铁律：镜头时长必须由**真实音频时长**决定，不能由估算值决定——
// 估算是给排期用的，写进时间轴的必须是文件里量出来的那个数。

import type { Character, Shot, TtsProvider } from './providers/index.js'

/** MiniMax 的 emotion 枚举，照官方文档抄，不要自己造词。 */
export type Emotion =
  'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised' | 'calm' | 'fluent' | 'whisper'

export type VoiceAssignment = {
  characterId: string
  name: string
  /** 系统音色 id，来自人物卡；跨集必须是同一个，否则观众会觉得换了个人 */
  voiceId: string
  /** 该角色的基调情绪，单条台词可以覆盖 */
  defaultEmotion: Emotion
  speed: number
}

export type VoiceClip = {
  shotId: string
  lineIndex: number
  characterId: string
  text: string
  path: string
  /** 从落盘文件里量出来的真实时长 */
  durationMs: number
  usageCharacters: number
  costCny: number
}

/**
 * 音色分配表。voiceId 直接取人物卡里的字段，不在这里现编——
 * 人物卡是 D2 定下来的档案，跨集一致性靠它，不靠这一天的临时映射。
 */
export function assignVoices(
  characters: Character[],
  moods: Record<string, { emotion: Emotion; speed: number }>
): VoiceAssignment[] {
  // 练习 1：voiceId 取人物卡里的 c.voiceId，情绪与语速取 moods 里这个角色那一条（取不到再退回默认）。
  // 提示：默认实现给所有人发同一个通用音色，于是第 1 步的分配表里两个角色是同一行音色 id，
  //       合出来的两个人一个声音。跨集一致性靠人物卡这份档案，不靠这里现编。
  void moods
  return characters.map((c) => ({
    characterId: c.id,
    name: c.name,
    voiceId: 'male-qn-qingse',
    defaultEmotion: 'calm' as Emotion,
    speed: 1,
  }))
}

/** 台词字数估算出来的时长，只用来在报告里跟真实时长做对照。 */
export const SECONDS_PER_HANZI_ESTIMATE = 0.22

export function estimateMs(text: string): number {
  return Math.round(text.length * SECONDS_PER_HANZI_ESTIMATE * 1000)
}

export async function synthesizeShot(
  tts: TtsProvider,
  shot: Shot,
  voices: VoiceAssignment[],
  outDir: (name: string) => string,
  overrides: Record<string, Emotion> = {}
): Promise<VoiceClip[]> {
  const clips: VoiceClip[] = []
  for (const [i, line] of shot.dialogue.entries()) {
    const v = voices.find((x) => x.characterId === line.characterId)
    if (!v) throw new Error(`分镜 ${shot.id} 的台词引用了没有音色的角色 ${line.characterId}`)
    const r = await tts.synthesize({
      text: line.text,
      voiceId: v.voiceId,
      outPath: outDir(`voice-${i + 1}.mp3`),
      emotion: overrides[`${shot.id}:${i}`] ?? v.defaultEmotion,
      speed: v.speed,
    })
    // 练习 2：时长要用合成结果里的 r.durationMs——那是从落盘文件里量出来的真实值。
    // 提示：默认实现写死 3000ms，于是第 2 步的「偏差」列全是几百上千毫秒的假数，
    //       字幕每条都恰好三秒。时间轴一旦建立在估算值上，音画就一定会漂。
    clips.push({
      shotId: shot.id,
      lineIndex: i,
      characterId: line.characterId,
      text: line.text,
      path: r.path,
      durationMs: 3000,
      usageCharacters: r.usageCharacters,
      costCny: r.costCny,
    })
  }
  return clips
}
