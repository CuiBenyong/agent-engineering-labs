// D5 实验（solution）：按角色配音，用真实音频时长校正镜头时长，产出时间轴与字幕文件。
// 当天要看到的三个现象：
//   1. 每个角色用的是自己的音色，日志里能看到音色 id 与情绪
//   2. 台词说不完的镜头被顶长，报告里标出「计划 → 实际」的差
//   3. SRT 的时间码连续、不重叠，自检输出「未发现问题」

import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { ensureFfmpeg } from './ffmpeg.js'
import { createProviders, isMock, type Character, type Shot } from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, newRunId, writeJson } from './run.js'
import { assignVoices, estimateMs, synthesizeShot, type Emotion, type VoiceClip } from './voice.js'
import {
  buildTimeline,
  defaultMixPlan,
  toSrt,
  validateCues,
  validateEntries,
  validateSrt,
  formatTimecode,
} from './timeline.js'

// ---------- D2 的产物：本天直接内置一份 ----------

function draftCharacters(): Character[] {
  return [
    {
      id: 'c1',
      name: '林野',
      appearance: '二十五岁男性，蓝色外卖工服',
      personality: '嘴硬心软',
      voiceId: 'junlang_nanyou',
    },
    {
      id: 'c2',
      name: '苏晓',
      appearance: '二十三岁女性，米色针织衫',
      personality: '冷静敏锐',
      voiceId: 'danya_xuejie',
    },
  ]
}

/** 角色基调：情绪与语速。跨集必须是同一份，否则同一个人会时快时慢。 */
const MOODS: Record<string, { emotion: Emotion; speed: number }> = {
  c1: { emotion: 'calm', speed: 1 },
  c2: { emotion: 'calm', speed: 0.95 },
}

/** 个别台词的情绪覆盖，键是「镜号:台词序号」。 */
const LINE_EMOTION: Record<string, Emotion> = {
  's02:0': 'surprised',
  's03:1': 'angry',
}

function draftShots(): Shot[] {
  return [
    {
      id: 's01',
      sceneId: 'sc1',
      shotSize: 'wide',
      durationSec: 6,
      characters: ['c1'],
      visual: '雨夜居民楼下，男主蹲在电动车旁',
      camera: '缓慢推近',
      dialogue: [{ characterId: 'c1', text: '这手机怎么自己亮了' }],
    },
    {
      id: 's02',
      sceneId: 'sc1',
      shotSize: 'close',
      durationSec: 3,
      characters: ['c1'],
      visual: '手机屏幕特写，显示五分钟后的新闻推送',
      camera: '固定机位',
      // 两句台词塞进 3 秒的计划时长，这一镜必定被顶长——留着当教学现场。
      dialogue: [
        { characterId: 'c1', text: '五分钟后的新闻，现在就推过来了' },
        { characterId: 'c1', text: '这不可能，一定是哪里出错了' },
      ],
    },
    {
      id: 's03',
      sceneId: 'sc2',
      shotSize: 'medium',
      durationSec: 8,
      characters: ['c1', 'c2'],
      visual: '便利店门口，女主拦下正要离开的男主',
      camera: '横移跟拍',
      dialogue: [
        { characterId: 'c2', text: '那部手机，不是你的' },
        { characterId: 'c1', text: '你是谁，凭什么拦我' },
      ],
    },
  ]
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()

  const providers = createProviders()
  const run = new Run(newRunId())
  await run.init()

  const characters = draftCharacters()
  const shots = draftShots()
  const voices = assignVoices(characters, MOODS)

  console.log(
    `模式：${isMock() ? 'MOCK 离线占位' : `真实厂商 ${providers.tts.name} / ${providers.tts.model}`}`
  )
  console.log(`产物目录：${run.dir}\n`)

  // ---- 1. 音色分配表 ----
  console.log('▸ 1/5 音色分配')
  console.log('    角色  姓名  音色 id              基调      语速')
  for (const v of voices) {
    console.log(
      `    ${v.characterId}    ${v.name}  ${v.voiceId.padEnd(20)} ${v.defaultEmotion.padEnd(9)} ${v.speed}`
    )
  }

  // ---- 2. 批量合成 ----
  console.log('\n▸ 2/5 批量合成台词')
  const clipsByShot = new Map<string, VoiceClip[]>()
  for (const shot of shots) {
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
      const est = estimateMs(c.text)
      console.log(
        `    ${c.shotId}#${c.lineIndex + 1} ${String(c.durationMs).padStart(5)}ms` +
          `（估算 ${est}ms，偏差 ${c.durationMs - est >= 0 ? '+' : ''}${c.durationMs - est}ms）  ${c.text}`
      )
    }
  }

  // ---- 3. 时长回写 ----
  console.log('\n▸ 3/5 用真实语音时长校正镜头时长')
  const { entries, cues, timings, totalMs } = buildTimeline(shots, clipsByShot, (shotId) =>
    run.path('shots', shotId, 'clip.mp4')
  )
  console.log('    镜号  计划     需要     采用     ')
  for (const t of timings) {
    console.log(
      `    ${t.shotId}   ${String(t.plannedMs).padStart(5)}ms  ${String(t.requiredMs).padStart(5)}ms  ` +
        `${String(t.finalMs).padStart(5)}ms  ${t.conflict ? '← 台词装不下，已顶长' : ''}`
    )
  }
  // 回写进分镜数据：后面每一天读到的 durationSec 都是校正后的值。
  for (const shot of shots) {
    const t = timings.find((x) => x.shotId === shot.id)
    if (t) shot.durationSec = Number((t.finalMs / 1000).toFixed(2))
  }
  await writeJson(run.path('script', 'episode-1.json'), { shots })

  // ---- 4. 字幕 ----
  console.log('\n▸ 4/5 由时间轴生成字幕')
  const srt = toSrt(cues)
  const srtPath = run.path('output', 'episode-1.srt')
  await mkdir(run.path('output'), { recursive: true })
  await writeFile(srtPath, srt, 'utf8')
  for (const c of cues.slice(0, 3)) {
    console.log(
      `    ${c.index}  ${formatTimecode(c.startMs)} --> ${formatTimecode(c.endMs)}  ${c.text}`
    )
  }
  console.log(`    …共 ${cues.length} 条，写入 ${srtPath}`)

  // ---- 5. 自检 ----
  console.log('\n▸ 5/5 时间码自检')
  const problems = [
    ...validateEntries(entries),
    ...validateCues(cues, entries),
    ...validateSrt(srt),
  ]
  if (problems.length === 0)
    console.log('    ✅ 未发现问题：镜头首尾相接、字幕连续不重叠且不越出画面、时间码格式合法')
  else for (const p of problems) console.log(`    ❌ ${p}`)

  const mix = defaultMixPlan()
  await writeJson(run.path('timeline', 'episode-1.json'), { entries, cues, timings, totalMs, mix })
  await run.save({ totalMs, cues: cues.length })

  console.log(`\n本集总时长 ${(totalMs / 1000).toFixed(2)} 秒，语音账单 ¥${run.totalCny}`)
  console.log(
    `混音意图：人声 ${mix.voiceDb}dB、环境 ${mix.ambienceDb}dB、背景乐 ${mix.musicDb}dB、说话时闪避 ${mix.duckDb}dB`
  )
  console.log('这份时间轴与混音计划就是 D6 剪辑台的全部输入——它不会再自己算一遍时间。')
  process.exitCode = problems.length === 0 ? 0 : 1
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
