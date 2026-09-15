// D6 实验（solution）：把一集全部素材合成竖屏成片与封面。
// 这一天只做一件事——把 D5 写好的时间轴表翻译成 ffmpeg 参数，
// 并且每一条参数都能追回到表里的某一行。时间一律只读，不重算。

import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  CANVAS,
  FADE_MS,
  attachSubtitles,
  concatCopy,
  concatXfade,
  duckWindows,
  entryDurationMs,
  extractCover,
  meanVolumeDb,
  mixBackground,
  pickCoverMs,
  probeDurationSec,
  probeStreams,
  renderMusicBed,
  renderSegment,
  shiftCuesForCrossfade,
  type Timeline,
} from './compose.js'
import { CHARACTERS, LINE_EMOTION, MOODS, SHOTS } from './episode.js'
import { ensureFfmpeg, ffmpeg } from './ffmpeg.js'
import { createProviders, isMock, PRICE } from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, newRunId, writeJson } from './run.js'
// 下面这三个模块来自 D5，本天不改：时间轴、字幕、混音计划全部由它们产出。
import { buildTimeline, defaultMixPlan, toSrt, type SubtitleCue } from './timeline.js'
import { assignVoices, synthesizeShot, type VoiceClip } from './voice.js'

const EPISODE = 1
const TRANSITION = process.env.TRANSITION === 'fade'
/** 故障注入。本天只有一个值：badtiming —— 把时间轴里某一镜的时长改错。 */
const INJECT = process.env.INJECT

/** 占位背景乐。真实项目里换成你有授权的音乐文件，版权红线见 README。 */
async function ensureBgm(path: string, totalMs: number): Promise<string> {
  const custom = process.env.BGM_PATH
  if (custom) return custom
  await mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true })
  await ffmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=196:d=${Math.ceil(totalMs / 1000)}`,
      '-c:a',
      'libmp3lame',
      path,
    ],
    { quiet: true }
  )
  return path
}

/**
 * INJECT=badtiming：把 s02 的时长砍掉 1.2 秒，后面所有镜头整体前移。
 * 注意注入点在**读回时间轴之后**——改的是表，不是素材，
 * 所以成片出问题时，你顺着现象一路查回来，落点必然是这张表。
 */
function injectBadTiming(timeline: Timeline): Timeline {
  const CUT_MS = 1200
  let shift = 0
  const entries = timeline.entries.map((e) => {
    const moved = { ...e, startMs: e.startMs - shift, endMs: e.endMs - shift }
    if (e.shotId === 's02') {
      moved.endMs -= CUT_MS
      shift += CUT_MS
    }
    return moved
  })
  console.log(`⚠️  已注入 badtiming：s02 的时长被砍掉 ${CUT_MS}ms，成片总时长跟着缩短。`)
  return { ...timeline, entries, totalMs: timeline.totalMs - CUT_MS }
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()
  const providers = createProviders()
  const run = new Run(newRunId())
  await run.init()
  console.log(`模式：${isMock() ? 'MOCK 离线占位' : `真实厂商 ${providers.video.name}`}`)
  console.log(`产物目录：${run.dir}\n`)

  // ---------- 第一步：备料。完整流水线里这些来自 D4 与 D5，这里就地生成一份。 ----------
  console.log('① 备料：镜头视频与台词配音（D4 / D5 的活儿，本天不改）')
  const voices = assignVoices(CHARACTERS, MOODS)
  const clipsByShot = new Map<string, VoiceClip[]>()

  // **先配音，后拍画面。** 这个顺序是有代价换来的：
  // 台词说完要多久，决定了这一镜到底需要多长；反过来推不出来。
  // 2026-09-07 实测踩过：按剧本原定的 3 秒去请求视频，而配音实际要 7.13 秒，
  // 于是合成时只能克隆末帧补 2.7 秒——成片里就是两秒多的定格，一眼能看出来。
  // 所以备料分两轮：先把台词合成完、用 planShot 算出这一镜真正需要的时长，
  // 再拿这个时长去请求画面。多花的钱是零，省下的是一堆冻结画面。
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
        provider: providers.tts.name as 'mock' | 'minimax',
        kind: 'tts',
        model: providers.tts.model,
        units: c.usageCharacters,
        costCny: c.costCny,
        cached: false,
      })
    }
  }

  // 时间轴由 D5 的 buildTimeline 算出来并落盘；D6 随后把它**读回来**再用，
  // 这样「D6 只消费时间轴」就不只是一句口号，而是代码里真实存在的一道边界。
  const built = buildTimeline(SHOTS, clipsByShot, (id) => run.path('shots', id, 'clip.mp4'))
  const timelinePath = run.path('timeline', `episode-${EPISODE}.json`)
  await writeJson(timelinePath, { ...built, mix: defaultMixPlan() })

  // ---------- 第二步：读表。本天所有的时间都来自这里，一个数都不重算。 ----------
  console.log('\n② 读时间轴表（只读，不重算）')
  let timeline = JSON.parse(await readFile(timelinePath, 'utf8')) as Timeline
  if (INJECT === 'badtiming') timeline = injectBadTiming(timeline)

  const { entries, cues, mix } = timeline
  const totalMs = entries[entries.length - 1]?.endMs ?? 0
  const cuesByShot = new Map<string, SubtitleCue[]>()
  for (const c of cues) cuesByShot.set(c.shotId, [...(cuesByShot.get(c.shotId) ?? []), c])

  for (const e of entries) {
    const overflow = (cuesByShot.get(e.shotId) ?? []).filter((c) => c.endMs > e.endMs)
    console.log(
      `   ${e.shotId}  ${String(e.startMs).padStart(6)} → ${String(e.endMs).padStart(6)} ms  ` +
        `${(cuesByShot.get(e.shotId) ?? []).length} 句${overflow.length ? `  ⚠️ ${overflow.length} 句台词越出画面` : ''}`
    )
  }
  console.log(`   总时长 ${(totalMs / 1000).toFixed(2)} 秒`)
  console.log(
    `   混音计划：人声 ${mix.voiceDb}dB / 环境音 ${mix.ambienceDb}dB / 背景乐 ${mix.musicDb}dB / 闪避 ${mix.duckDb}dB`
  )
  console.log(`   （${mix.note}）`)

  // 字幕用 D5 的 cues 与 toSrt 生成，D6 不碰时间码。
  // 唯一的例外是转场：那几百毫秒是剪辑台自己吃掉的，得由剪辑台补偿回去，且不回写时间轴。
  const srtCues = TRANSITION ? shiftCuesForCrossfade(cues, entries) : cues
  const srtPath = run.path('output', `episode-${EPISODE}.srt`)
  await mkdir(run.path('output'), { recursive: true })
  await writeFile(srtPath, toSrt(srtCues), 'utf8')
  console.log(`   字幕文件：${srtPath}（${cues.length} 条，时间码由 D5 算好）`)
  if (TRANSITION) {
    console.log(
      `   已按 ${entries.length - 1} 个 ${FADE_MS}ms 转场把字幕时间码整体前移（时间轴本身不动）。`
    )
  }

  // ---------- 第三步：一镜一段，先归一化。 ----------
  console.log('\n③ 归一化每一镜（顺带把台词按 cue 的时间摆进去）')
  const segments: string[] = []
  for (const entry of entries) {
    const seg = run.path('segments', `${entry.shotId}.mp4`)
    await renderSegment(entry, cuesByShot.get(entry.shotId) ?? [], mix, seg)
    segments.push(seg)
  }

  // ---------- 第四步：拼接。两条路，转场决定走哪条。 ----------
  console.log(`\n④ 拼接（${TRANSITION ? 'xfade 滤镜图，重编码' : 'concat 分离器，流拷贝'}）`)
  const joined = run.path('segments', 'joined.mp4')
  if (TRANSITION) await concatXfade(segments, entries.map(entryDurationMs), joined)
  else await concatCopy(segments, run.path('segments', 'concat.txt'), joined)

  // ---------- 第五步：背景乐（按计划闪避）+ 字幕。 ----------
  console.log('\n⑤ 背景乐与字幕')
  const bed = run.path('segments', 'music-bed.m4a')
  await renderMusicBed(
    await ensureBgm(run.path('assets', 'bgm.mp3'), totalMs),
    bed,
    totalMs,
    mix,
    cues
  )
  const withBgm = run.path('segments', 'with-bgm.mp4')
  await mixBackground(joined, bed, withBgm)

  const finalPath = run.path('output', `episode-${EPISODE}.mp4`)
  const mode = await attachSubtitles(withBgm, srtPath, finalPath)
  console.log(
    mode === 'burned'
      ? '   探测到 subtitles 滤镜，字幕已烧进画面。'
      : '   本机 ffmpeg 没有 subtitles 滤镜（编译时缺 libass），已回落为软字幕轨，播放器里手动打开即可。'
  )

  // ---------- 第六步：封面。 ----------
  const coverMs = pickCoverMs(
    entries,
    new Set(SHOTS.filter((s) => s.shotSize === 'close').map((s) => s.id))
  )
  const coverPath = run.path('output', `cover-${EPISODE}.jpg`)
  await extractCover(finalPath, coverMs, coverPath)
  console.log(
    `\n⑥ 封面：第 ${(coverMs / 1000).toFixed(2)} 秒（第一个特写镜头的中点）→ ${coverPath}`
  )

  // ---------- 验收 ----------
  console.log('\n成片流信息（ffprobe）：')
  for (const s of await probeStreams(finalPath)) {
    console.log(`   #${s.index} ${s.type.padEnd(8)} ${s.codec.padEnd(10)} ${s.detail}`)
  }
  console.log(`   画布 ${CANVAS.width}x${CANVAS.height} @ ${CANVAS.fps}fps`)
  console.log(
    `   成片时长 ${await probeDurationSec(finalPath)} 秒，时间轴 ${(totalMs / 1000).toFixed(2)} 秒`
  )

  await reportDucking(bed, cues, totalMs, mix.duckDb)

  await run.save({ episode: EPISODE, totalMs, subtitleMode: mode, mix })
  console.log(`\n成片：${finalPath}`)
  console.log(
    `本次花费 ¥${run.totalCny}（离线模式下全部为 0；折算口径见 README：视频按 ¥${PRICE.videoPerSecond}/秒的档位价折算，不是某个模型的官方标价）`
  )
}

/** 对单独渲染出来的背景乐做一次响度核对：有人声的区间应当比没人声的区间低 duckDb 左右。 */
async function reportDucking(
  bedPath: string,
  cues: SubtitleCue[],
  totalMs: number,
  duckDb: number
) {
  const windows = duckWindows(cues)
  const inside = windows[0]
  const quiet = findQuietWindow(windows, totalMs)
  if (!inside || !quiet) return
  const loud = await meanVolumeDb(bedPath, quiet[0], quiet[1])
  const ducked = await meanVolumeDb(bedPath, inside[0], inside[1])
  console.log('\n混音核对（只量背景乐这一条轨，混进人声之后就量不出来了）：')
  console.log(
    `   没人说话时 ${loud.toFixed(1)} dB，有人说话时 ${ducked.toFixed(1)} dB，实测压低 ${(loud - ducked).toFixed(1)} dB`
  )
  console.log(`   计划闪避 ${duckDb} dB —— 对得上说明混音计划真的落到了参数上。`)
}

/** 找一段谁都没说话的时间，用来做闪避的对照组。 */
function findQuietWindow(windows: [number, number][], totalMs: number): [number, number] | null {
  let cursor = 0
  for (const [a, b] of [...windows].sort((x, y) => x[0] - y[0])) {
    if (a - cursor >= 500) return [cursor + 50, a - 50]
    cursor = Math.max(cursor, b)
  }
  return totalMs - cursor >= 500 ? [cursor + 50, totalMs - 50] : null
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
