// 时间轴：本课唯一一处「时间」的权威定义，D6 的剪辑台只读它、不再自己算。
// 这一天只负责把数字算对，怎么把它变成 ffmpeg 参数是 D6 的事。

import type { Shot, TimelineEntry } from './providers/index.js'
import type { VoiceClip } from './voice.js'

/** 每个镜头台词前后各留一点空，说完就切镜会显得很赶。 */
export const LEAD_MS = 250
export const TAIL_MS = 400
/** 同一镜里两句台词之间的停顿。 */
export const GAP_MS = 180

export type ShotTiming = {
  shotId: string
  /** 分镜数据里原来写的计划时长 */
  plannedMs: number
  /** 由真实语音时长算出来的实际需要时长 */
  requiredMs: number
  /** 最终采用的时长 */
  finalMs: number
  /** 计划时长不够装下台词，被顶长了 */
  conflict: boolean
}

export type SubtitleCue = {
  index: number
  /** 这条字幕属于哪一镜——自检时要靠它确认字幕没有越出镜头边界 */
  shotId: string
  startMs: number
  endMs: number
  text: string
  characterId: string
}

/**
 * 时长是双向约束：画面想要多长、台词需要多长，两个数不一样时必须有人让步。
 * 本课的口径是**台词优先**——把话说完永远比守住计划时长重要，
 * 因为观众能看出话被切掉，看不出这一镜比原计划多了 0.8 秒。
 * 被顶长的镜头会被标成 conflict，交给 D10 的审核台让人复核。
 */
export function planShot(shot: Shot, clips: VoiceClip[]): ShotTiming {
  const plannedMs = Math.round(shot.durationSec * 1000)
  // 练习 3：算出 requiredMs（LEAD_MS + 全部语音时长 + 句间停顿 + TAIL_MS），
  //         再取它与 plannedMs 的较大值作为 finalMs，requiredMs 更大时把 conflict 标成 true。
  // 提示：默认实现直接采用计划时长，于是 s02 那一镜的两句台词根本装不下，
  //       第 5 步会打印「越出了 s02 的画面 N 毫秒，台词会飘到下一镜」。
  void clips
  void LEAD_MS
  void TAIL_MS
  void GAP_MS
  return { shotId: shot.id, plannedMs, requiredMs: plannedMs, finalMs: plannedMs, conflict: false }
}

export type BuildResult = {
  entries: TimelineEntry[]
  cues: SubtitleCue[]
  timings: ShotTiming[]
  totalMs: number
}

/** 按镜头顺序累加，产出时间轴条目与字幕 cue。两者共用同一个游标，这是不漂移的唯一保证。 */
export function buildTimeline(
  shots: Shot[],
  clipsByShot: Map<string, VoiceClip[]>,
  clipPathOf: (shotId: string) => string
): BuildResult {
  const entries: TimelineEntry[] = []
  const cues: SubtitleCue[] = []
  const timings: ShotTiming[] = []
  let cursor = 0

  for (const shot of shots) {
    const clips = clipsByShot.get(shot.id) ?? []
    const timing = planShot(shot, clips)
    timings.push(timing)

    // 字幕落在镜头内部：先留 LEAD_MS，再一句接一句，句间留 GAP_MS。
    let lineCursor = cursor + LEAD_MS
    for (const clip of clips) {
      cues.push({
        index: cues.length + 1,
        shotId: shot.id,
        startMs: lineCursor,
        endMs: lineCursor + clip.durationMs,
        text: clip.text,
        characterId: clip.characterId,
      })
      lineCursor += clip.durationMs + GAP_MS
    }

    entries.push({
      shotId: shot.id,
      startMs: cursor,
      endMs: cursor + timing.finalMs,
      clipPath: clipPathOf(shot.id),
      voicePath: clips[0]?.path,
      subtitle: clips.map((c) => c.text).join(' '),
    })
    cursor += timing.finalMs
  }

  return { entries, cues, timings, totalMs: cursor }
}

// ---------- SRT ----------

/** SRT 的时间码是 HH:MM:SS,mmm，分隔符是逗号不是句点，写错了播放器直接不认。 */
export function formatTimecode(ms: number): string {
  // 练习 4：按 HH:MM:SS,mmm 输出——两位小时、两位分、两位秒，毫秒三位，分隔符是逗号。
  // 提示：默认实现既没补零也用了句点，第 5 步的 SRT 自检会把每一行时间码都判成不合法。
  //       这种字幕文件播放器要么整个不加载，要么只显示第一条，排查起来非常费时间。
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${h}:${m}:${s}.${ms % 1000}`
}

/**
 * 竖屏一行放不下太多字，超过 SUBTITLE_MAX_CHARS 就断成两行。
 * 断行优先找标点，找不到再硬断——硬断很容易在第二行留下一个孤零零的字，
 * 所以标点的搜索范围要一直下探到 MIN_LINE_CHARS，宁可两行长短不均，也不要孤字。
 */
export const SUBTITLE_MAX_CHARS = 14
const MIN_LINE_CHARS = 4
const BREAKABLE = '，。！？、；：'

export function wrapSubtitle(text: string, max = SUBTITLE_MAX_CHARS): string {
  if (text.length <= max) return text
  for (let i = Math.min(max, text.length - 1); i >= MIN_LINE_CHARS; i -= 1) {
    if (BREAKABLE.includes(text[i]!)) return `${text.slice(0, i + 1)}\n${text.slice(i + 1)}`
  }
  return `${text.slice(0, max)}\n${text.slice(max)}`
}

export function toSrt(cues: SubtitleCue[]): string {
  return (
    cues
      .map((c) =>
        [
          `${c.index}`,
          `${formatTimecode(c.startMs)} --> ${formatTimecode(c.endMs)}`,
          wrapSubtitle(c.text),
        ].join('\n')
      )
      .join('\n\n') + '\n'
  )
}

/**
 * 时间码自检，三件事：起止递增、cue 之间不重叠、每条字幕都落在它所属的镜头里面。
 * 第三条最容易被忽略——字幕越界不会报错，只会让上一镜的台词飘到下一镜的画面上。
 */
export function validateCues(cues: SubtitleCue[], entries: TimelineEntry[]): string[] {
  const problems: string[] = []
  const bounds = new Map(entries.map((e) => [e.shotId, e]))
  let prevEnd = -1
  for (const c of cues) {
    if (c.endMs <= c.startMs) problems.push(`第 ${c.index} 条的结束时间不晚于开始时间`)
    if (c.startMs < prevEnd)
      problems.push(`第 ${c.index} 条与上一条重叠了 ${prevEnd - c.startMs}ms`)
    const shot = bounds.get(c.shotId)
    if (shot && c.endMs > shot.endMs) {
      problems.push(
        `第 ${c.index} 条越出了 ${c.shotId} 的画面 ${c.endMs - shot.endMs}ms，台词会飘到下一镜`
      )
    }
    prevEnd = Math.max(prevEnd, c.endMs)
  }
  return problems
}

/** SRT 文本自检：时间码必须是 HH:MM:SS,mmm --> HH:MM:SS,mmm，一位都不能少。 */
const TIMECODE_LINE = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/

export function validateSrt(srt: string): string[] {
  const problems: string[] = []
  for (const line of srt.split('\n')) {
    if (!line.includes('-->')) continue
    if (!TIMECODE_LINE.test(line)) problems.push(`时间码格式不合法：${line}`)
  }
  return problems
}

/** 时间轴条目自检：镜头必须首尾相接，中间不能有洞也不能叠。 */
export function validateEntries(entries: TimelineEntry[]): string[] {
  const problems: string[] = []
  let expected = 0
  for (const e of entries) {
    if (e.startMs !== expected)
      problems.push(`${e.shotId} 应从 ${expected}ms 开始，实际 ${e.startMs}ms`)
    if (e.endMs <= e.startMs) problems.push(`${e.shotId} 的时长不是正数`)
    expected = e.endMs
  }
  return problems
}

// ---------- 混音意图 ----------

/**
 * 响度关系只写「相对多少分贝」，不写任何平台的响度标准，也不在这里生成 ffmpeg 参数。
 * 这份计划跟着时间轴一起交给 D6，由剪辑台去落成命令。
 */
export type MixPlan = {
  voiceDb: number
  ambienceDb: number
  musicDb: number
  /** 有人说话时把背景乐再压低多少，也就是常说的闪避 */
  duckDb: number
  note: string
}

export function defaultMixPlan(): MixPlan {
  return {
    voiceDb: 0,
    ambienceDb: -12,
    musicDb: -18,
    duckDb: -6,
    note: '相对关系的起点，不是任何平台的响度标准；成片出来必须用耳朵复核一遍',
  }
}
