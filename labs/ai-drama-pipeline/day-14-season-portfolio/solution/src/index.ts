// D14 实验（solution）：一次运行产出一季五集，检查跨集一致性，出整季账单与作品集材料。
//
// 四步：
//   ① 用世界观档案驱动五集连续生成（提示词只从档案里拼）
//   ② 五条跨集一致性检查逐项打印通过与否
//   ③ 整季账单：耗时、花费、失败率、人工介入次数
//   ④ 作品集材料：演示片花 + 架构图 + 说明文档

import 'dotenv/config'
import { rm, writeFile } from 'node:fs/promises'
import { ensureFfmpeg } from './ffmpeg.js'
import { createProviders, isMock } from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, newRunId, writeJson } from './run.js'
import { SEASON, WORLD, imagePrompt, videoPrompt, type EpisodePlan } from './world.js'
import { checkConsistency } from './consistency.js'
import { estimateEpisode, printSeasonLedger, summarize, type EpisodeRecord } from './ledger.js'
import { ARCHITECTURE_MMD, buildDemoReel, portfolioReadme } from './portfolio.js'

/**
 * 故障注入的统一开关（全课约定）：INJECT=a,b 逗号分隔。本天只支持一个值——
 *   taskfail  让 e3s02 的视频第一次生成失败、退避后重试成功，演示「失败要进账单」
 * 不注入时整季失败率是 0%，账单照样打印，只是失败那一列全是 0。
 */
const INJECT = new Set(
  (process.env.INJECT ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)
const FLAKY_SHOT = INJECT.has('taskfail') ? 'e3s02' : null

async function produceEpisode(
  run: Run,
  ep: EpisodePlan
): Promise<{ record: EpisodeRecord; firstClip: string; episodePath: string }> {
  const providers = createProviders()
  const started = Date.now()
  let images = 0
  let videoSeconds = 0
  let ttsCharacters = 0
  let attempts = 0
  let failures = 0
  let firstClip = ''

  console.log(`\n  ▸ E${ep.n}《${ep.title}》${ep.pickUp ? `承接：${ep.pickUp}` : '开篇'}`)

  for (const shot of ep.shots) {
    const framePath = run.path('shots', shot.id, 'first-frame.png')
    attempts += 1
    await providers.image.generate({
      prompt: imagePrompt(WORLD, shot),
      outPath: framePath,
      aspectRatio: '9:16',
    })
    images += 1

    const clipPath = run.path('shots', shot.id, 'clip.mp4')
    // 一次失败 + 一次重试：真实环境里视频接口的失败率不低，账单必须把它算进去。
    const tries = shot.id === FLAKY_SHOT ? 2 : 1
    for (let t = 1; t <= tries; t += 1) {
      attempts += 1
      if (t < tries) {
        failures += 1
        console.log(
          `      · ${shot.id} 视频生成失败（第 ${t} 次），退避后重试；失败不扣费，但要进账单`
        )
        continue
      }
      await providers.video.generate({
        prompt: videoPrompt(WORLD, shot),
        outPath: clipPath,
        durationSec: shot.durationSec,
        resolution: '768P',
      })
    }
    videoSeconds += shot.durationSec
    if (!firstClip) firstClip = clipPath

    for (const [i, line] of shot.dialogue.entries()) {
      const who = WORLD.cast.find((c) => c.id === line.characterId)
      attempts += 1
      await providers.tts.synthesize({
        text: line.text,
        voiceId: who?.voiceId ?? 'male-qn-qingse',
        outPath: run.path('shots', shot.id, `voice-${i + 1}.mp3`),
      })
      ttsCharacters += line.text.length
    }
  }

  await writeJson(run.path('script', `episode-${ep.n}.json`), {
    episode: ep.n,
    title: ep.title,
    pickUp: ep.pickUp,
    hook: ep.hook,
    shots: ep.shots.map((s) => ({
      ...s,
      imagePrompt: imagePrompt(WORLD, s),
      videoPrompt: videoPrompt(WORLD, s),
    })),
  })

  // 本集成片：两镜流复制拼起来，一次都不重新编码。
  const episodePath = run.path('output', `episode-${ep.n}.mp4`)
  await buildDemoReel(
    ep.shots.map((s) => run.path('shots', s.id, 'clip.mp4')),
    episodePath,
    run.path('output', `concat-${ep.n}.txt`)
  )

  const base = {
    n: ep.n,
    title: ep.title,
    ms: Date.now() - started,
    images,
    videoSeconds,
    ttsCharacters,
    attempts,
    failures,
    // 标了 needsReview 的集子要人过一遍：审核台上改台词、点重生成都记一次。
    manualTouches: ep.needsReview ? 1 : 0,
  }
  console.log(
    `      · 产出 ${ep.shots.length} 镜，${videoSeconds} 秒，调用 ${attempts} 次，失败 ${failures} 次；成片 ${episodePath}`
  )
  return { record: { ...base, estimatedCny: estimateEpisode(base) }, firstClip, episodePath }
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()
  await rm('work', { recursive: true, force: true })
  const run = new Run(newRunId())
  await run.init()

  console.log(`模式：${isMock() ? 'MOCK 离线占位（金额为估算值）' : '真实厂商'}`)
  console.log(`剧集：《${WORLD.title}》——${WORLD.logline}`)
  console.log(`产物目录：${run.dir}`)

  // ① 世界观档案落盘，再驱动五集
  await writeJson(run.path('script', 'world.json'), WORLD)
  await writeJson(run.path('script', 'characters.json'), WORLD.cast)
  console.log('\n① 用世界观档案驱动五集连续生成')
  const records: EpisodeRecord[] = []
  const firstClips: string[] = []
  for (const ep of SEASON) {
    const { record, firstClip } = await produceEpisode(run, ep)
    records.push(record)
    firstClips.push(firstClip)
  }

  // ② 跨集一致性
  console.log('\n② 跨集一致性检查')
  const checks = checkConsistency(WORLD, SEASON)
  for (const c of checks) console.log(`   ${c.pass ? '✅' : '❌'} ${c.label}：${c.detail}`)
  const passed = checks.filter((c) => c.pass).length
  console.log(`   ${passed} / ${checks.length} 项通过`)

  // ③ 整季账单
  const summary = summarize(records)
  printSeasonLedger(records, summary)

  // ④ 作品集材料
  console.log('\n④ 作品集材料')
  const demoPath = run.path('output', 'portfolio', 'demo.mp4')
  await buildDemoReel(firstClips, demoPath, run.path('output', 'portfolio', 'reel.txt'))
  console.log(`   演示片花：${demoPath}（每集抽第一镜，流复制拼接，没有重新编码）`)

  const mmdPath = run.path('output', 'portfolio', 'architecture.mmd')
  await writeFile(mmdPath, ARCHITECTURE_MMD, 'utf8')
  console.log(`   架构图：${mmdPath}（mermaid 源码，贴进任何支持 mermaid 的地方即可出图）`)

  const readmePath = run.path('output', 'portfolio', 'README.md')
  await writeFile(readmePath, portfolioReadme(WORLD, summary, passed, checks.length), 'utf8')
  console.log(`   说明文档：${readmePath}（数字已按本次运行填好，三个技术故事的骨架也在里面）`)

  await run.save({ world: WORLD.id, episodes: records, summary, consistency: checks })
  console.log(`\n整季元信息与账本：${run.path('run.json')}`)
  console.log(
    '下一步：把 README.md 里三个技术故事各扩写成两分钟能讲完的版本，对着面试追问清单自答一遍。'
  )
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
