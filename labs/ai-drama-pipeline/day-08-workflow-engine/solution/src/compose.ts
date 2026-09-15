// 剪辑台：把时间轴表翻译成 ffmpeg 参数。
// 这一天不产生任何时间——时间全部来自 D5 写好的时间轴，本文件只做「表 → 参数」的翻译。
// 全文也没有一处让模型生成命令：模型只填提示词，参数由这里的纯函数算出来。

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ffmpeg, hasFilter } from './ffmpeg.js'
import type { MixPlan, ShotTiming, SubtitleCue } from './timeline.js'
import type { TimelineEntry } from './providers/index.js'

const run = promisify(execFile)

/** D5 写进 timeline/episode-N.json 的完整形状。D6 只读它，一个字段都不重算。 */
export type Timeline = {
  entries: TimelineEntry[]
  cues: SubtitleCue[]
  timings: ShotTiming[]
  totalMs: number
  mix: MixPlan
}

/** 竖屏成片的编码口径。各平台的具体规格是 D13 的事，这里只保证是一条通用的竖屏 H.264。 */
export const CANVAS = { width: 1080, height: 1920, fps: 24, sampleRate: 44100 } as const

/** 转场时长。加了转场，成片总时长会比时间轴短 (段数-1) * 这个值。 */
export const FADE_MS = 300

const VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '128k', '-ar', String(CANVAS.sampleRate), '-ac', '2']
const AFORMAT = `aformat=sample_fmts=fltp:sample_rates=${CANVAS.sampleRate}:channel_layouts=stereo`

async function ensureDir(path: string) {
  await mkdir(dirname(path), { recursive: true })
}

const seconds = (ms: number) => (ms / 1000).toFixed(3)
export const entryDurationMs = (e: TimelineEntry) => e.endMs - e.startMs

/** 有没有音轨要先探，图生视频的产物经常是纯画面。 */
export async function hasAudioStream(path: string): Promise<boolean> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=index',
    '-of',
    'csv=p=0',
    path,
  ])
  return stdout.trim().length > 0
}

/**
 * 一镜里的每句台词各是一个文件。D5 把第一句的路径写进了 entry.voicePath，
 * 其余各句按同一目录下 voice-1 / voice-2 …的命名规律排开——这是 §2.1 的目录约定，
 * 所以这里按 cue 的条数推出路径，而不是自己再去扫目录。
 */
export function voicePathsOf(entry: TimelineEntry, cueCount: number): string[] {
  if (!entry.voicePath || cueCount === 0) return []
  const dir = dirname(entry.voicePath)
  return Array.from({ length: cueCount }, (_, i) => join(dir, `voice-${i + 1}.mp3`))
}

/**
 * 一镜一段：统一画布、统一帧率、统一采样率，并按时间轴把这一镜的台词摆到正确的位置。
 * 「先归一化再拼接」是这一天最重要的工程决定：只有每段参数完全一致，
 * 后面那步拼接才能不重新编码。
 *
 * 混音的两档增益（人声与环境音）来自 D5 的混音计划，本函数只负责把分贝落成 volume 参数。
 */
export async function renderSegment(
  entry: TimelineEntry,
  cues: SubtitleCue[],
  mix: MixPlan,
  outPath: string
): Promise<void> {
  await ensureDir(outPath)
  const dur = seconds(entryDurationMs(entry))
  const voices = voicePathsOf(entry, cues.length)
  const inputs = ['-i', entry.clipPath, ...voices.flatMap((p) => ['-i', p])]
  const chains: string[] = []

  // tpad 先克隆末帧把画面补到至少一个时间槽长，再由 trim 裁回时间槽。
  // 为什么需要它：2026-09-07 实测，请求 6 秒的镜头，厂商实际返回的是 5.875 秒。
  // 不补的话这一段就会「视频 5.875 秒、音频 6 秒」——尾巴上 125 毫秒只有声音没有画面，
  // 而这个误差是**逐镜累加**的：四十个镜头就是五秒的音画错位。
  // 时间轴是权威（D5 按真实配音时长算出来的），所以画面要去填满它，而不是反过来。
  // 片段比时间槽长时 tpad 什么也不加，trim 照常裁剪，两个方向都对。
  chains.push(
    `[0:v]scale=${CANVAS.width}:${CANVAS.height}:force_original_aspect_ratio=decrease,` +
      `pad=${CANVAS.width}:${CANVAS.height}:-1:-1:color=black,fps=${CANVAS.fps},` +
      `tpad=stop_mode=clone:stop_duration=${dur},trim=duration=${dur},setpts=PTS-STARTPTS[v]`
  )

  // 环境音来自镜头视频自带的声音；没有音轨就补一段静音，保证每段的音频参数一致。
  const ambienceSrc = (await hasAudioStream(entry.clipPath))
    ? `[0:a]volume=${mix.ambienceDb}dB`
    : `anullsrc=r=${CANVAS.sampleRate}:cl=stereo`
  chains.push(`${ambienceSrc},${AFORMAT},apad,atrim=duration=${dur},asetpts=PTS-STARTPTS[amb]`)

  const labels = ['amb']
  cues.forEach((cue, i) => {
    // 台词的入点由 cue 的绝对时间减去镜头起点算出来，不是随便延迟一个固定值。
    const offset = Math.max(0, cue.startMs - entry.startMs)
    chains.push(
      `[${i + 1}:a]${AFORMAT},volume=${mix.voiceDb}dB,adelay=${offset}|${offset},` +
        `apad,atrim=duration=${dur},asetpts=PTS-STARTPTS[vo${i}]`
    )
    labels.push(`vo${i}`)
  })

  chains.push(
    labels.length === 1
      ? `[amb]anull[a]`
      : `${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[a]`
  )

  await ffmpeg([
    ...inputs,
    '-filter_complex',
    chains.join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...VIDEO_ENCODE,
    '-r',
    String(CANVAS.fps),
    ...AUDIO_ENCODE,
    '-t',
    dur,
    outPath,
  ])
}

/**
 * 拼接路线一：concat 分离器 + 流拷贝。不重新编码，二十秒的片子零点几秒就出来，
 * 代价是各段的编码参数必须完全一致——这正是上面归一化那一步买来的。
 */
export async function concatCopy(
  segments: string[],
  listPath: string,
  outPath: string
): Promise<void> {
  await ensureDir(listPath)
  // concat 分离器按行读文件名，单引号要转义；用绝对路径省掉相对路径的坑。
  const list = segments.map((p) => `file '${resolve(p).replace(/'/g, `'\\''`)}'`).join('\n')
  await writeFile(listPath, `${list}\n`, 'utf8')
  await ffmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath,
  ])
}

/**
 * 拼接路线二：xfade 滤镜图。要转场就必须重新编码，因为转场那几帧是新算出来的画面。
 * 每一段的 offset 都要把前面已经吃掉的转场时长减回去，算错了就会越拼越早。
 */
export async function concatXfade(
  segments: string[],
  durationsMs: number[],
  outPath: string,
  fadeMs = FADE_MS
): Promise<void> {
  await ensureDir(outPath)
  const fade = seconds(fadeMs)
  const chains: string[] = []
  let vLabel = '0:v'
  let aLabel = '0:a'
  let offsetMs = 0

  for (let i = 1; i < segments.length; i += 1) {
    offsetMs += durationsMs[i - 1] - fadeMs
    chains.push(
      `[${vLabel}][${i}:v]xfade=transition=fade:duration=${fade}:offset=${seconds(offsetMs)}[v${i}]`
    )
    chains.push(`[${aLabel}][${i}:a]acrossfade=d=${fade}:c1=tri:c2=tri[a${i}]`)
    vLabel = `v${i}`
    aLabel = `a${i}`
  }

  await ffmpeg([
    ...segments.flatMap((p) => ['-i', p]),
    '-filter_complex',
    chains.join(';'),
    '-map',
    `[${vLabel}]`,
    '-map',
    `[${aLabel}]`,
    ...VIDEO_ENCODE,
    '-r',
    String(CANVAS.fps),
    ...AUDIO_ENCODE,
    '-movflags',
    '+faststart',
    outPath,
  ])
}

/**
 * 转场是剪辑台自己造成的时间位移：第 i 段被前面 i 个转场各吃掉 fadeMs。
 * 时间轴是 D5 的真相，本函数**不回写它**，只把字幕的时间码补偿一份出来给 SRT 用——
 * 谁引入的位移谁负责补偿，这是这条边界的正确形状。
 */
export function shiftCuesForCrossfade(
  cues: SubtitleCue[],
  entries: TimelineEntry[],
  fadeMs = FADE_MS
): SubtitleCue[] {
  const indexOf = new Map(entries.map((e, i) => [e.shotId, i]))
  return cues.map((c) => {
    const shift = (indexOf.get(c.shotId) ?? 0) * fadeMs
    return { ...c, startMs: c.startMs - shift, endMs: c.endMs - shift }
  })
}

// ---------- 背景乐与闪避 ----------

/** 有人说话的时间段。闪避就是在这些区间里把背景乐再压低 duckDb。 */
export function duckWindows(cues: SubtitleCue[], padMs = 150): [number, number][] {
  return cues.map((c) => [Math.max(0, c.startMs - padMs), c.endMs + padMs])
}

/** 把「哪些时间段要闪避」翻译成 volume 滤镜的 enable 表达式。多个区间相加即可。 */
export function duckEnableExpr(windows: [number, number][]): string {
  return windows.map(([a, b]) => `between(t,${seconds(a)},${seconds(b)})`).join('+')
}

/**
 * 单独渲染一条背景乐音轨：整体压到 musicDb，人声区间再压 duckDb。
 * 单独出一条而不是直接混进成片，是为了能对它单独做响度核对——
 * 混完之后人声会把整体抬起来，那时候再量就量不出闪避了。
 */
export async function renderMusicBed(
  bgmPath: string,
  outPath: string,
  totalMs: number,
  mix: MixPlan,
  cues: SubtitleCue[]
): Promise<void> {
  await ensureDir(outPath)
  const enable = duckEnableExpr(duckWindows(cues))
  const filters = [`volume=${mix.musicDb}dB`]
  if (enable) filters.push(`volume=volume=${mix.duckDb}dB:enable='${enable}'`)
  await ffmpeg([
    '-stream_loop',
    '-1',
    '-i',
    bgmPath,
    '-t',
    seconds(totalMs),
    '-af',
    `${filters.join(',')},${AFORMAT}`,
    ...AUDIO_ENCODE,
    outPath,
  ])
}

/** 把背景乐铺进成片。视频流原样拷贝，只重编码音轨。 */
export async function mixBackground(
  videoPath: string,
  bedPath: string,
  outPath: string
): Promise<void> {
  await ensureDir(outPath)
  await ffmpeg([
    '-i',
    videoPath,
    '-i',
    bedPath,
    '-filter_complex',
    `[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]`,
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'copy',
    ...AUDIO_ENCODE,
    outPath,
  ])
}

/** 量一段音频的平均响度，用来核对混音计划真的落地了。 */
export async function meanVolumeDb(path: string, fromMs: number, toMs: number): Promise<number> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-v',
    'info',
    '-i',
    path,
    '-af',
    `atrim=start=${seconds(fromMs)}:end=${seconds(toMs)},volumedetect`,
    '-f',
    'null',
    '-',
  ])
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr)
  return m ? Number(m[1]) : Number.NaN
}

// ---------- 字幕 ----------

export type SubtitleMode = 'burned' | 'soft'

/**
 * 字幕：先探测能力再决定走哪条路。
 * 烧录要 ffmpeg 编译时带 libass，很多发行版的默认包没有；
 * 探测不到就回落成软字幕轨，成片照样出得来，只是播放器要手动打开字幕。
 */
export async function attachSubtitles(
  videoPath: string,
  srtPath: string,
  outPath: string
): Promise<SubtitleMode> {
  await ensureDir(outPath)
  if (await hasFilter('subtitles')) {
    // 烧进画面：字幕成为像素，任何播放器都关不掉，短剧发行通常要的就是这个。
    const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, `\\'`)
    await ffmpeg([
      '-i',
      videoPath,
      '-vf',
      `subtitles='${escaped}'`,
      ...VIDEO_ENCODE,
      '-r',
      String(CANVAS.fps),
      '-c:a',
      'copy',
      outPath,
    ])
    return 'burned'
  }
  // 回落：作为独立字幕轨封装进 mp4。mov_text 是 mp4 容器认的字幕编码。
  await ffmpeg([
    '-i',
    videoPath,
    '-i',
    srtPath,
    '-c',
    'copy',
    '-c:s',
    'mov_text',
    '-metadata:s:s:0',
    'language=chi',
    outPath,
  ])
  return 'soft'
}

// ---------- 封面 ----------

/** 封面：从指定时间点截一帧。别用第一帧——开场往往是黑场或推近的起点，最没有信息量。 */
export async function extractCover(
  videoPath: string,
  atMs: number,
  outPath: string
): Promise<void> {
  await ensureDir(outPath)
  // -ss 放在 -i 前面走关键帧快速定位，截封面这种精度要求不高的场景足够。
  // 显式指定 yuvj420p：不同拼接路线出来的视频色彩范围标记不一样，
  // 不指定的话 mjpeg 编码器会在某些片子上直接拒绝工作（报 Non full-range YUV is non-standard）。
  await ffmpeg([
    '-ss',
    seconds(atMs),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-pix_fmt',
    'yuvj420p',
    '-q:v',
    '2',
    outPath,
  ])
}

/**
 * 封面时间点：优先取第一个特写镜头的中点。
 * 理由是特写有脸、有情绪，缩略图在手机上只有指甲盖大，全景什么都看不清。
 */
export function pickCoverMs(entries: TimelineEntry[], closeShotIds: Set<string>): number {
  const target = entries.find((e) => closeShotIds.has(e.shotId)) ?? entries[0]
  return Math.round((target.startMs + target.endMs) / 2)
}

// ---------- 验收 ----------

export type StreamInfo = { index: number; type: string; codec: string; detail: string }

export async function probeStreams(path: string): Promise<StreamInfo[]> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=index,codec_type,codec_name,width,height,channels,sample_rate',
    '-of',
    'json',
    path,
  ])
  const parsed = JSON.parse(stdout) as {
    streams: {
      index: number
      codec_type: string
      codec_name: string
      width?: number
      height?: number
      channels?: number
      sample_rate?: string
    }[]
  }
  return parsed.streams.map((s) => ({
    index: s.index,
    type: s.codec_type,
    codec: s.codec_name,
    detail:
      s.codec_type === 'video'
        ? `${s.width}x${s.height}`
        : s.codec_type === 'audio'
          ? `${s.channels}ch ${s.sample_rate}Hz`
          : '',
  }))
}

export async function probeDurationSec(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  return Number(Number.parseFloat(stdout.trim()).toFixed(3))
}
