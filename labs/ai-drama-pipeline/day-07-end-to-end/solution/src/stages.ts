// 六个环节，一字排开。
// D1 到 D6 每天各调一次自己的接口，今天第一次让它们首尾相接——
// 于是产物路径、中间态、日志这三件之前无所谓的事，全都变成了问题。
//
// 环节 id 与 D4 / D5 落进成本台账的 nodeId 保持一致：first-frame、clip、voice。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  attachSubtitles,
  concatCopy,
  entryDurationMs,
  extractCover,
  mixBackground,
  pickCoverMs,
  probeStreams,
  renderMusicBed,
  renderSegment,
  type Timeline,
} from './compose.js'
import { CHARACTERS, LINE_EMOTION, MOODS, SHOTS } from './episode.js'
import { ffmpeg } from './ffmpeg.js'
import type { TaskNode } from './dag.js'
import type { Providers, Shot } from './providers/index.js'
import { writeJson, type Run } from './run.js'
import {
  GAP_MS,
  LEAD_MS,
  TAIL_MS,
  buildTimeline,
  defaultMixPlan,
  toSrt,
  type SubtitleCue,
} from './timeline.js'
import { assignVoices, synthesizeShot, type VoiceClip, estimateMs } from './voice.js'

/** 故障注入。本天只有一个值：failnode4 —— 让第四个环节（clip）失败。 */
const INJECT = process.env.INJECT

/** 六个环节的顺序，注入 failnode4 时找的就是这个数组的第四项。 */
/** 这一镜请求素材时该用多长：剧本计划与台词字数估算取大者（理由见调用处注释）。 */
function plannedSec(shot: Shot): number {
  const spoken = shot.dialogue.reduce((sum, l) => sum + estimateMs(l.text), 0)
  if (spoken === 0) return shot.durationSec
  const gaps = Math.max(0, shot.dialogue.length - 1) * GAP_MS
  const needed = (LEAD_MS + spoken + gaps + TAIL_MS) / 1000
  return Math.max(shot.durationSec, Number(needed.toFixed(2)))
}

export const STAGE_IDS = ['script', 'assets', 'first-frame', 'clip', 'voice', 'compose'] as const

function maybeFail(nodeId: string) {
  if (INJECT === 'failnode4' && nodeId === STAGE_IDS[3]) {
    throw new Error(`（注入 failnode4）${nodeId} 环节失败：厂商返回了一个不可重试的错误`)
  }
}

export type StageContext = { idea: string; episode: number; run: Run; providers: Providers }

export function buildStages(ctx: StageContext): TaskNode[] {
  const { idea, episode, run, providers } = ctx
  const p = (name: string) => name as 'mock' | 'minimax'
  const clipsByShot = new Map<string, VoiceClip[]>()

  return [
    {
      id: 'script',
      title: '剧本与人物卡',
      deps: [],
      run: async () => {
        const r = await providers.text.complete({
          system: '你是一位短剧编剧，只输出中文。',
          user: `把这句话扩写成一集竖屏短剧的一句话梗概：${idea}`,
        })
        run.record({
          nodeId: 'script',
          provider: p(providers.text.name),
          kind: 'text',
          model: providers.text.model,
          units: r.promptTokens + r.completionTokens,
          costCny: 0,
          cached: false,
        })
        const a = [
          run.path('script', 'characters.json'),
          run.path('script', `episode-${episode}.json`),
        ]
        await writeJson(a[0], CHARACTERS)
        await writeJson(a[1], { idea, logline: r.text, shots: SHOTS })
        return { artifacts: a, note: `梗概 ${r.text.length} 字` }
      },
    },
    {
      id: 'assets',
      title: '角色定妆图',
      deps: ['script'],
      run: async () => {
        const artifacts: string[] = []
        for (const c of CHARACTERS) {
          const r = await providers.image.generate({
            prompt: `${c.appearance}，${c.personality}，竖屏人物定妆照`,
            outPath: run.path('assets', 'characters', c.id, 'base.png'),
            aspectRatio: '9:16',
          })
          run.record({
            nodeId: 'assets',
            provider: p(providers.image.name),
            kind: 'image',
            model: providers.image.model,
            units: 1,
            costCny: r.costCny,
            cached: false,
          })
          artifacts.push(r.path)
        }
        return { artifacts }
      },
    },
    {
      id: 'first-frame',
      title: '每镜首帧',
      deps: ['assets'],
      run: async () => {
        const artifacts: string[] = []
        for (const s of SHOTS) {
          const r = await providers.image.generate({
            prompt: `${s.visual}，${s.shotSize} 景别`,
            outPath: run.path('shots', s.id, 'first-frame.png'),
            aspectRatio: '9:16',
            referenceImage: run.path('assets', 'characters', s.characters[0]!, 'base.png'),
          })
          run.record({
            nodeId: 'first-frame',
            provider: p(providers.image.name),
            kind: 'image',
            model: providers.image.model,
            units: 1,
            costCny: r.costCny,
            cached: false,
          })
          artifacts.push(r.path)
        }
        return { artifacts }
      },
    },
    {
      id: 'clip',
      title: '镜头视频',
      deps: ['first-frame'],
      run: async () => {
        const artifacts: string[] = []
        for (const s of SHOTS) {
          // 请求素材的时长按「剧本计划」与「台词字数估算」取大者。
          // 剧本给的 3 秒装不下一句 25 字的台词：按 3 秒去请求，合成时只能克隆末帧补两秒多，
          // 成片里就是一段定格。这里用 D5 的 estimateMs 先估一把——
          // **排期用估算，对齐用实测**：估算保证素材够长，最终时长仍由时间轴说了算。
          const needSec = plannedSec(s)
          const r = await providers.video.generate({
            prompt: `${s.visual}，${s.camera}`,
            outPath: run.path('shots', s.id, 'clip.mp4'),
            durationSec: needSec,
            firstFrame: run.path('shots', s.id, 'first-frame.png'),
          })
          run.record({
            nodeId: 'clip',
            provider: p(providers.video.name),
            kind: 'video',
            model: providers.video.model,
            units: needSec,
            costCny: r.costCny,
            cached: false,
          })
          artifacts.push(r.path)
          // 注入点在循环里：真实的失败也是这样，前几镜已经出钱了，后几镜还没开始。
          maybeFail('clip')
        }
        return { artifacts }
      },
    },
    {
      id: 'voice',
      title: '配音与时间轴',
      deps: ['script'],
      run: async () => {
        const voices = assignVoices(CHARACTERS, MOODS)
        const artifacts: string[] = []
        for (const shot of SHOTS) {
          const clips = await synthesizeShot(
            providers.tts,
            shot,
            voices,
            (name) => run.path('shots', shot.id, name),
            LINE_EMOTION
          )
          clipsByShot.set(shot.id, clips)
          for (const c of clips) {
            run.record({
              nodeId: 'voice',
              provider: p(providers.tts.name),
              kind: 'tts',
              model: providers.tts.model,
              units: c.usageCharacters,
              costCny: c.costCny,
              cached: false,
            })
            artifacts.push(c.path)
          }
        }
        // 时长回写与时间轴都是 D5 的活儿，本环节照它的口径来，D6 的合成只读结果。
        const built = buildTimeline(SHOTS, clipsByShot, (id) => run.path('shots', id, 'clip.mp4'))
        for (const shot of SHOTS) {
          const t = built.timings.find((x) => x.shotId === shot.id)
          if (t) shot.durationSec = Number((t.finalMs / 1000).toFixed(2))
        }
        const timelinePath = run.path('timeline', `episode-${episode}.json`)
        await writeJson(timelinePath, { ...built, mix: defaultMixPlan() })
        await mkdir(run.path('output'), { recursive: true })
        const srt = run.path('output', `episode-${episode}.srt`)
        await writeFile(srt, toSrt(built.cues), 'utf8')
        artifacts.push(timelinePath, srt)
        const conflicts = built.timings.filter((t) => t.conflict).length
        return { artifacts, note: `${built.cues.length} 条字幕，${conflicts} 镜被顶长` }
      },
    },
    {
      id: 'compose',
      title: '剪辑合成',
      deps: ['clip', 'voice'],
      run: async () => {
        // 时间轴从磁盘读回来，而不是从上一个环节的内存里传过来——
        // 串联的目的就是让每一步的交接都过一次文件，串起来才和分开跑是同一件事。
        const timeline = JSON.parse(
          await readFile(run.path('timeline', `episode-${episode}.json`), 'utf8')
        ) as Timeline
        const { entries, cues, mix } = timeline
        const totalMs = entries[entries.length - 1]?.endMs ?? 0
        const byShot = new Map<string, SubtitleCue[]>()
        for (const c of cues) byShot.set(c.shotId, [...(byShot.get(c.shotId) ?? []), c])

        const segments: string[] = []
        for (const entry of entries) {
          const seg = run.path('segments', `${entry.shotId}.mp4`)
          await renderSegment(entry, byShot.get(entry.shotId) ?? [], mix, seg)
          segments.push(seg)
        }
        const joined = run.path('segments', 'joined.mp4')
        await concatCopy(segments, run.path('segments', 'concat.txt'), joined)

        const bgm = run.path('assets', 'bgm.mp3')
        await ffmpeg(
          [
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=196:d=${Math.ceil(totalMs / 1000)}`,
            '-c:a',
            'libmp3lame',
            bgm,
          ],
          { quiet: true }
        )
        const bed = run.path('segments', 'music-bed.m4a')
        await renderMusicBed(bgm, bed, totalMs, mix, cues)
        const withBgm = run.path('segments', 'with-bgm.mp4')
        await mixBackground(joined, bed, withBgm)

        const final = run.path('output', `episode-${episode}.mp4`)
        const mode = await attachSubtitles(
          withBgm,
          run.path('output', `episode-${episode}.srt`),
          final
        )

        const cover = run.path('output', `cover-${episode}.jpg`)
        const closeIds = new Set(SHOTS.filter((s) => s.shotSize === 'close').map((s) => s.id))
        await extractCover(final, pickCoverMs(entries, closeIds), cover)

        const streams = await probeStreams(final)
        const longest = Math.max(...entries.map(entryDurationMs))
        return {
          artifacts: [final, cover],
          note: `${(totalMs / 1000).toFixed(1)} 秒，最长一镜 ${(longest / 1000).toFixed(1)} 秒，字幕走${
            mode === 'burned' ? '烧录' : '软字幕'
          }，${streams.length} 条流`,
        }
      },
    },
  ]
}
