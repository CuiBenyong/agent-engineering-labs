// D2 实验（starter）：一句话进，一份能被程序直接消费的分镜数据出。
// 全文有 4 个编号练习：review.ts 两个、index.ts 一个、schema.ts 一个。
// 今天的产出全是 JSON，没有一张图、一段视频——但后面十二天吃的全是这份 JSON 里的字段。

import 'dotenv/config'
import { createProviders, isMock, type Character } from './providers/index.js'
import { pickTextProvider } from './offline.js'
import { MAX_ROUNDS, PASS_SCORE, review, type Review } from './review.js'
import { draftCharacters, draftEpisode, draftWorld } from './writer.js'
import { Run, newRunId, writeJson } from './run.js'
import type { Episode } from './schema.js'

const IDEA = process.argv.slice(2).join(' ') || '外卖小哥捡到一部会预知未来的手机'

async function main() {
  const text = pickTextProvider(createProviders().text)
  const run = new Run(newRunId())
  await run.init()

  console.log(`模式：${isMock() ? 'MOCK 离线剧本' : `真实模型 ${text.model}`}`)
  console.log(`一句话：${IDEA}`)
  console.log(`达标线：${PASS_SCORE} 分，最多 ${MAX_ROUNDS} 轮`)
  console.log(`产物目录：${run.dir}\n`)

  // 世界观与人物卡是跨集共用的档案，只做一次，之后每一集都读它。
  console.log('▸ 世界观档案')
  const world = await draftWorld(text, IDEA)
  console.log(`    ${world.title}｜${world.logline}`)
  await writeJson(run.path('script', 'world.json'), world)

  console.log('▸ 人物卡')
  const characters: Character[] = await draftCharacters(text, IDEA, world)
  for (const c of characters) console.log(`    ${c.id} ${c.name}  音色 ${c.voiceId}`)
  await writeJson(run.path('script', 'characters.json'), characters)

  // 写手与评审的循环：达标或者到次数上限就停。每一轮的稿子和评语都留档。
  console.log('\n▸ 写手与评审循环')
  let feedback: string[] = []
  let best: { episode: Episode; review: Review } | null = null

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const episode = await draftEpisode(text, { idea: IDEA, world, characters, feedback })
    const r = await review(text, episode, characters)
    await writeJson(run.path('script', 'drafts', `round-${round}.json`), episode)
    await writeJson(run.path('script', 'drafts', `round-${round}.review.json`), r)

    console.log(
      `  第 ${round} 轮：${r.score} 分（硬伤 ${r.hard.length} 条）${r.score >= PASS_SCORE ? '  达标' : ''}`
    )
    for (const h of r.hard.slice(0, 3)) console.log(`      ${h}`)
    if (r.hard.length > 3) console.log(`      （另有 ${r.hard.length - 3} 条同类问题）`)
    for (const s of r.soft) console.log(`      软评：${s}`)

    // 练习 3：让循环真的会停，并且交出最好的那一稿。
    //   (1) 分数达到 PASS_SCORE 就 break，别把配额烧在已经够用的稿子上；
    //   (2) 用 best 记住分数最高的一稿，跑满 MAX_ROUNDS 时交它而不是交最后一稿
    //       （最后一稿不一定最好，评审是有波动的）；
    //   (3) 跑满上限时打印一句话，告诉使用者这是「没达标但到上限」，该人工拍板了。
    //   现在的写法是：永远跑满 4 轮，最后一稿直接定稿。
    best = { episode, review: r }
    feedback = [...r.hard, ...r.soft]
  }

  if (!best) throw new Error('一轮都没跑成，检查上面的 schema 报错')
  await writeJson(run.path('script', 'episode-1.json'), best.episode)
  await run.save({ idea: IDEA, world: world.title, score: best.review.score })

  const total = best.episode.shots.reduce((s, x) => s + x.durationSec, 0)
  console.log(
    `\n定稿：${best.review.score} 分，${best.episode.shots.length} 个分镜，全集 ${total} 秒`
  )
  console.log(`  ${run.path('script', 'episode-1.json')}`)
  console.log(`  每一轮的稿子在 ${run.path('script', 'drafts')} 下，可以 diff 着看改了什么`)
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
