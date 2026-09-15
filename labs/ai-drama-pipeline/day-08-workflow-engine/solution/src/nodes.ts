// 第一周那六个环节，改写成六个工作流节点。
// 和 D7 的版本比，业务代码几乎没变——变的是「产物写到哪」和「输入怎么声明」。
// 节点之间只通过 ctx.depDir() 交接目录，任何一个节点都不知道别人是跑出来的还是缓存命中的。

import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  attachSubtitles,
  concatCopy,
  extractCover,
  mixBackground,
  pickCoverMs,
  renderMusicBed,
  renderSegment,
} from './compose.js'
import type { NodeSpec } from './dag.js'
import { CHARACTERS, LINE_EMOTION, MOODS, SHOTS } from './episode.js'
import { ffmpeg } from './ffmpeg.js'
import { PRICE, type CostEntry, type Providers, type Shot } from './providers/index.js'
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

/**
 * 形如 INJECT=failnode:clips —— 让指定节点抛错，用来演示断点续跑。
 * 全课的故障注入统一走 INJECT 这一个环境变量；这里的值带上节点名，
 * 因为引擎是按节点调度的，注入点必须能指定。
 */
const FAIL_NODE = ((v) => (v?.startsWith('failnode:') ? v.slice('failnode:'.length) : undefined))(
  process.env.INJECT
)

function maybeFail(nodeId: string) {
  if (FAIL_NODE === nodeId) throw new Error(`（人为注入）${nodeId} 失败：厂商返回了不可重试的错误`)
}

/**
 * 离线模式下厂商返回的 costCny 都是 0，台账会全是 ¥0，看不出省了多少钱。
 * 这里按 D1 里那份官方单价折算一遍——折算值只用于教学，真实账单以厂商后台为准。
 */
function estimate(kind: CostEntry['kind'], units: number, real: number): number {
  if (real > 0) return real
  if (kind === 'image') return units * PRICE.imagePerItem
  if (kind === 'video') return units * PRICE.videoPerSecond
  if (kind === 'tts') return units * PRICE.ttsPerCharacter
  return 0
}

/** 这一镜请求素材时该用多长：剧本计划与台词字数估算取大者（理由见调用处注释）。 */
function plannedSec(shot: Shot): number {
  const spoken = shot.dialogue.reduce((sum, l) => sum + estimateMs(l.text), 0)
  if (spoken === 0) return shot.durationSec
  const gaps = Math.max(0, shot.dialogue.length - 1) * GAP_MS
  const needed = (LEAD_MS + spoken + gaps + TAIL_MS) / 1000
  return Math.max(shot.durationSec, Number(needed.toFixed(2)))
}

export function buildNodes(idea: string, providers: Providers): NodeSpec[] {
  const p = (name: string) => name as 'mock' | 'minimax'

  return [
    {
      id: 'script',
      title: '剧本与人物卡',
      deps: [],
      version: 1,
      // 键里只有「一句话」和「文本模型」。换一句话，下面五个节点会连锁失效；
      // 同一句话再跑一百遍，一次都不会重新生成。
      inputs: { idea, model: providers.text.model },
      outputs: ['characters.json', 'episode.json'],
      run: async (ctx) => {
        const r = await providers.text.complete({
          system: '你是一位短剧编剧，只输出中文。',
          user: `把这句话扩写成一集竖屏短剧的一句话梗概：${idea}`,
        })
        ctx.record({
          nodeId: 'script',
          provider: p(providers.text.name),
          kind: 'text',
          model: providers.text.model,
          units: r.promptTokens + r.completionTokens,
          costCny: 0,
          cached: false,
        })
        maybeFail('script')
        await writeFile(
          join(ctx.outDir, 'characters.json'),
          JSON.stringify(CHARACTERS, null, 2),
          'utf8'
        )
        await writeFile(
          join(ctx.outDir, 'episode.json'),
          JSON.stringify({ idea, logline: r.text, shots: SHOTS }, null, 2),
          'utf8'
        )
        return { note: `梗概 ${r.text.length} 字` }
      },
    },
    {
      id: 'assets',
      title: '角色定妆图',
      deps: ['script'],
      version: 1,
      inputs: {
        model: providers.image.model,
        chars: CHARACTERS.map((c) => `${c.id}|${c.appearance}|${c.personality}`),
      },
      outputs: CHARACTERS.map((c) => `${c.id}.png`),
      run: async (ctx) => {
        // 从依赖的产物目录读人物卡，而不是直接 import。
        // 这一条让节点可以在别的进程、别的机器上跑，也是 D9 并行的前提。
        const chars = JSON.parse(
          await readFile(join(ctx.depDir('script'), 'characters.json'), 'utf8')
        ) as typeof CHARACTERS
        for (const c of chars) {
          const r = await providers.image.generate({
            prompt: `${c.appearance}，${c.personality}，竖屏人物定妆照`,
            outPath: join(ctx.outDir, `${c.id}.png`),
            aspectRatio: '9:16',
          })
          ctx.record({
            nodeId: 'assets',
            provider: p(providers.image.name),
            kind: 'image',
            model: providers.image.model,
            units: 1,
            costCny: estimate('image', 1, r.costCny),
            cached: false,
          })
        }
        maybeFail('assets')
        return { note: `${chars.length} 张定妆图` }
      },
    },
    {
      id: 'frames',
      title: '每镜首帧',
      deps: ['assets'],
      version: 1,
      inputs: {
        model: providers.image.model,
        shots: SHOTS.map((s) => `${s.id}|${s.visual}|${s.shotSize}`),
      },
      outputs: SHOTS.map((s) => `${s.id}.png`),
      run: async (ctx) => {
        for (const s of SHOTS) {
          const r = await providers.image.generate({
            prompt: `${s.visual}，${s.shotSize} 景别`,
            outPath: join(ctx.outDir, `${s.id}.png`),
            aspectRatio: '9:16',
            referenceImage: join(ctx.depDir('assets'), `${s.characters[0]}.png`),
          })
          ctx.record({
            nodeId: 'frames',
            provider: p(providers.image.name),
            kind: 'image',
            model: providers.image.model,
            units: 1,
            costCny: estimate('image', 1, r.costCny),
            cached: false,
          })
        }
        maybeFail('frames')
        return { note: `${SHOTS.length} 张首帧` }
      },
    },
    {
      id: 'clips',
      title: '镜头视频',
      deps: ['frames'],
      version: 1,
      inputs: {
        model: providers.video.model,
        shots: SHOTS.map((s) => `${s.id}|${s.visual}|${s.camera}|${s.durationSec}`),
      },
      outputs: SHOTS.map((s) => `${s.id}.mp4`),
      run: async (ctx) => {
        for (const s of SHOTS) {
          // 请求素材的时长按「剧本计划」与「台词字数估算」取大者。
          // 剧本给的 3 秒装不下一句 25 字的台词：按 3 秒去请求，合成时只能克隆末帧补两秒多，
          // 成片里就是一段定格。这里用 D5 的 estimateMs 先估一把——
          // **排期用估算，对齐用实测**：估算保证素材够长，最终时长仍由时间轴说了算。
          const needSec = plannedSec(s)
          const r = await providers.video.generate({
            prompt: `${s.visual}，${s.camera}`,
            outPath: join(ctx.outDir, `${s.id}.mp4`),
            durationSec: needSec,
            firstFrame: join(ctx.depDir('frames'), `${s.id}.png`),
          })
          ctx.record({
            nodeId: 'clips',
            provider: p(providers.video.name),
            kind: 'video',
            model: providers.video.model,
            units: needSec,
            costCny: estimate('video', needSec, r.costCny),
            cached: false,
          })
          // 注入点在循环里：真实的失败也是这样，前几镜已经出钱了，后几镜还没开始。
          maybeFail('clips')
        }
        return { note: `${SHOTS.length} 个镜头` }
      },
    },
    {
      id: 'voice',
      title: '台词配音',
      deps: ['script'],
      version: 1,
      inputs: {
        model: providers.tts.model,
        lines: SHOTS.map(
          (s) => `${s.id}|${s.dialogue.map((l) => `${l.characterId}:${l.text}`).join('/')}`
        ),
      },
      outputs: ['clips.json'],
      run: async (ctx) => {
        let characters = 0
        const voices = assignVoices(CHARACTERS, MOODS)
        const byShot: Record<string, VoiceClip[]> = {}
        for (const shot of SHOTS) {
          const clips = await synthesizeShot(
            providers.tts,
            shot,
            voices,
            // 一镜一个子目录：compose 里的 voicePathsOf 靠「同目录下 voice-N.mp3」这个约定
            // 找同一镜的其他台词，所以这里的布局必须和 D6 / D7 一致。
            (name) => join(ctx.outDir, shot.id, name),
            LINE_EMOTION
          )
          if (clips.length > 0) byShot[shot.id] = clips
          for (const c of clips) {
            characters += c.usageCharacters
            ctx.record({
              nodeId: 'voice',
              provider: p(providers.tts.name),
              kind: 'tts',
              model: providers.tts.model,
              units: c.usageCharacters,
              costCny: estimate('tts', c.usageCharacters, c.costCny),
              cached: false,
            })
          }
        }
        // 关键：把每句话的真实时长落盘。compose 不能指望 voice 这一轮真的跑过——
        // 它可能整节点命中缓存，内存里什么都没有。节点之间只认磁盘上的产物。
        await writeFile(join(ctx.outDir, 'clips.json'), JSON.stringify(byShot, null, 2), 'utf8')
        maybeFail('voice')
        return { note: `${characters} 个计费字符` }
      },
    },
    {
      id: 'compose',
      title: '剪辑合成',
      deps: ['clips', 'voice'],
      version: 1,
      // 合成不花钱，但它的键同样要认真写：改了画布或转场，成片就该重出。
      inputs: { canvas: '1080x1920@24', shots: SHOTS.map((s) => `${s.id}|${s.durationSec}`) },
      outputs: ['episode.mp4', 'episode.srt', 'cover.jpg'],
      run: async (ctx) => {
        // 配音时长从上游的产物里读，而不是从内存里拿——voice 可能是缓存命中的。
        const byShot = JSON.parse(
          await readFile(join(ctx.depDir('voice'), 'clips.json'), 'utf8')
        ) as Record<string, VoiceClip[]>
        const clipsByShot = new Map<string, VoiceClip[]>(Object.entries(byShot))
        const mix = defaultMixPlan()
        const { entries, cues, totalMs } = buildTimeline(SHOTS, clipsByShot, (id) =>
          join(ctx.depDir('clips'), `${id}.mp4`)
        )
        const srt = join(ctx.outDir, 'episode.srt')
        await writeFile(srt, toSrt(cues), 'utf8')

        const cuesByShot = new Map<string, SubtitleCue[]>()
        for (const cue of cues) {
          const list = cuesByShot.get(cue.shotId) ?? []
          list.push(cue)
          cuesByShot.set(cue.shotId, list)
        }

        const segments: string[] = []
        for (const entry of entries) {
          const seg = join(ctx.outDir, `seg-${entry.shotId}.mp4`)
          await renderSegment(entry, cuesByShot.get(entry.shotId) ?? [], mix, seg)
          segments.push(seg)
        }
        const joined = join(ctx.outDir, 'joined.mp4')
        await concatCopy(segments, join(ctx.outDir, 'concat.txt'), joined)

        const bgm = join(ctx.outDir, 'bgm.mp3')
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
        const bed = join(ctx.outDir, 'music-bed.m4a')
        await renderMusicBed(bgm, bed, totalMs, mix, cues)
        const withBgm = join(ctx.outDir, 'with-bgm.mp4')
        await mixBackground(joined, bed, withBgm)

        const final = join(ctx.outDir, 'episode.mp4')
        const mode = await attachSubtitles(withBgm, srt, final)

        const closeIds = new Set(SHOTS.filter((s) => s.shotSize === 'close').map((s) => s.id))
        await extractCover(final, pickCoverMs(entries, closeIds), join(ctx.outDir, 'cover.jpg'))

        maybeFail('compose')
        return {
          note: `${(totalMs / 1000).toFixed(1)} 秒，字幕走${mode === 'burned' ? '烧录' : '软字幕'}`,
        }
      },
    },
  ]
}

/** 把 compose 的产物取到本次运行目录里，让人不用去缓存目录翻文件。 */
export async function publishOutputs(
  composeDir: string,
  outputDir: string,
  episode: number
): Promise<string[]> {
  const pairs: [string, string][] = [
    ['episode.mp4', `episode-${episode}.mp4`],
    ['episode.srt', `episode-${episode}.srt`],
    ['cover.jpg', `cover-${episode}.jpg`],
  ]
  const out: string[] = []
  for (const [from, to] of pairs) {
    const target = join(outputDir, to)
    await copyFile(join(composeDir, from), target)
    out.push(target)
  }
  return out
}
