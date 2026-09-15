// D12 实验（solution）：按环节分档的模型路由 + 缓存 + 降级 + 预算熔断 + 成本面板。
//
// 一条命令跑完六个阶段，每个阶段都在同一份业务代码上换一组参数：
//   ① 草稿档跑一集   ② 成片档跑同一集   ③ 原样重跑（全命中缓存）
//   ④ 改一镜后重跑   ⑤ 硬上限熔断      ⑥ 软上限触发自动降级
//
// 所有金额都是估算：MOCK 下 provider 的 costCny 恒为 0，面板里的钱由 units × 公开单价算出。

import 'dotenv/config'
import { rm } from 'node:fs/promises'
import { ensureFfmpeg } from './ffmpeg.js'
import { createProviders, isMock, type Character, type Shot } from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, newRunId, writeJson } from './run.js'
import { ArtifactCache } from './cache.js'
import { Budget, BudgetExceededError } from './budget.js'
import { TIERS, degradeToFit, type StagePlan, type Tier } from './router.js'
import { Ledger, estimate, printPanel, round } from './pricing.js'

const CACHE_DIR = 'work/cache'
const IDEA = process.argv.slice(2).join(' ') || '外卖小哥捡到一部会预知未来的手机'

/**
 * 故障注入的统一开关（全课约定）：INJECT=a,b 逗号分隔。本天支持两个值——
 *   overbudget  把硬上限压到 ¥3 再跑成片档，演示熔断与安全停机
 *   blocked     让 s02 的第一次视频生成命中安全审核，演示「不扣费」的台账口径
 * 注入只作用在计费与 provider 出口，业务逻辑照常执行。
 */
const INJECT = new Set(
  (process.env.INJECT ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)

function characters(): Character[] {
  return [
    {
      id: 'c1',
      name: '林野',
      appearance: '二十五岁男性，短发，蓝色外卖工服',
      personality: '嘴硬心软',
      voiceId: 'junlang_nanyou',
    },
    {
      id: 'c2',
      name: '苏晓',
      appearance: '二十三岁女性，长发，米色针织衫',
      personality: '冷静敏锐',
      voiceId: 'danya_xuejie',
    },
  ]
}

function shots(visualOfS02 = '手机屏幕特写，显示着五分钟后的新闻推送'): Shot[] {
  return [
    {
      id: 's01',
      sceneId: 'sc1',
      shotSize: 'wide',
      durationSec: 6,
      characters: ['c1'],
      visual: '雨夜的老旧居民楼下，男主蹲在电动车旁翻看一部亮着的手机',
      camera: '缓慢推近',
      dialogue: [{ characterId: 'c1', text: '这手机怎么自己亮了' }],
    },
    {
      id: 's02',
      sceneId: 'sc1',
      shotSize: 'close',
      durationSec: 6,
      characters: ['c1'],
      visual: visualOfS02,
      camera: '固定机位',
      dialogue: [{ characterId: 'c1', text: '五分钟后？这不可能' }],
    },
    {
      id: 's03',
      sceneId: 'sc2',
      shotSize: 'medium',
      durationSec: 6,
      characters: ['c1', 'c2'],
      visual: '便利店门口，女主拦下正要离开的男主',
      camera: '横移跟拍',
      dialogue: [{ characterId: 'c2', text: '那部手机，不是你的' }],
    },
  ]
}

// ---------- 花多少钱：先算，再花 ----------

/** 事前预估：不调任何接口，只按计划算这一集要花多少。熔断与降级都靠它。 */
function project(plan: StagePlan, cast: Character[], list: Shot[]): number {
  // 练习 1：把这一集的预估花费算出来（一个请求都不许发）。
  //   镜头数按 plan.maxShots 截断；图像张数 = 定妆图（plan.characterSheets 为真才有）+ 每镜首帧；
  //   视频秒数 = 每镜 min(durationSec, plan.maxShotSeconds) 之和；语音按台词字数。
  //   三项分别用 estimate('image', n) / estimate(plan.videoRateId, 秒) / estimate('tts', 字数) 相加。
  // 现在返回 0：阶段 ⑥ 会以为怎么跑都不花钱，直接放行——这就是没做完的现象。
  void plan
  void cast
  void list
  void estimate
  return round(0)
}

type Produced = { ledger: Ledger; run: Run; artifacts: string[]; stopped?: BudgetExceededError }

async function produceEpisode(opts: {
  tier: Tier
  plan?: StagePlan
  cache: ArtifactCache
  budget: Budget
  visualOfS02?: string
  /** 演示「失败与命中安全审核的视频不扣费」：这一镜第一次会被拦下 */
  blockedShotId?: string
}): Promise<Produced> {
  const plan = opts.plan ?? TIERS[opts.tier]
  const providers = createProviders()
  const ledger = new Ledger()
  const run = new Run(newRunId())
  await run.init()

  const cast = characters()
  const picked = shots(opts.visualOfS02).slice(0, plan.maxShots)
  const artifacts: string[] = []
  let blockedOnce = false
  let stopped: BudgetExceededError | undefined

  const spend = async (
    stage: string,
    rateId: Parameters<typeof estimate>[0],
    units: number,
    outPath: string,
    keyParts: Record<string, string | number | boolean>,
    generate: () => Promise<void>
  ) => {
    const key = opts.cache.key({ ...keyParts, stage, tier: plan.videoResolution })
    if (await opts.cache.take(key, outPath)) {
      // 命中缓存：记账但不花钱，也不占预算。
      ledger.add({
        stage,
        provider: 'cache',
        kind: kindOf(stage),
        model: 'cache',
        units,
        rateId,
        cached: true,
        billed: true,
        rateApprox: false,
      })
      artifacts.push(outPath)
      return
    }
    const cost = estimate(rateId, units)
    opts.budget.reserve(stage, cost)

    if (stage === 'clips' && keyParts.shotId === opts.blockedShotId && !blockedOnce) {
      // 命中安全审核：任务失败，产物没有，但点数不扣——所以要退预算、并记一条不计费的行。
      // 练习 5：被安全审核拦下的视频不扣费，台账要照实记。
      //   正确做法：把刚刚预扣的 cost 用 budget.refund(cost) 退回去，
      //   记一条 billed: false 的行（面板会把它算进「未计费」而不是花费），
      //   然后重新 reserve 一次，进入重试。
      // 现在直接记成正常花费：面板会多算一笔本来不收钱的账，
      // 而且预算被白占掉一份——看不到「未计费」那一行就是没做完。
      blockedOnce = true
      ledger.add({
        stage,
        provider: providers.video.name,
        kind: 'video',
        model: providers.video.model,
        units,
        rateId,
        cached: false,
        billed: true,
        rateApprox: false,
        note: '命中安全审核（status_code 1026/1027），改写提示词后重试',
      })
    }

    await generate()
    await opts.cache.put(key, outPath)
    ledger.add({
      stage,
      provider: providerNameOf(stage, providers),
      kind: kindOf(stage),
      model: modelOf(stage, providers, plan),
      units,
      rateId,
      cached: false,
      billed: true,
      rateApprox: stage === 'clips' && plan.videoResolution === '512P',
      note:
        stage === 'clips' && plan.videoResolution === '512P'
          ? '单价表无 512P 一档，按 768P 单价往贵了估'
          : undefined,
    })
    artifacts.push(outPath)
  }

  try {
    if (plan.characterSheets) {
      for (const c of cast) {
        const out = run.path('assets', 'characters', c.id, 'base.png')
        await spend(
          'assets',
          'image',
          1,
          out,
          { charId: c.id, appearance: c.appearance },
          async () => {
            await providers.image.generate({
              prompt: `${c.appearance}，${c.personality}，竖屏人物定妆照`,
              outPath: out,
            })
          }
        )
      }
    }

    for (const s of picked) {
      const out = run.path('shots', s.id, 'first-frame.png')
      await spend(
        'frames',
        'image',
        1,
        out,
        { shotId: s.id, visual: s.visual, size: s.shotSize },
        async () => {
          await providers.image.generate({
            prompt: `${s.visual}，${s.shotSize} 景别`,
            outPath: out,
          })
        }
      )
    }

    for (const s of picked) {
      const seconds = Math.min(s.durationSec, plan.maxShotSeconds)
      const out = run.path('shots', s.id, 'clip.mp4')
      await spend(
        'clips',
        plan.videoRateId,
        seconds,
        out,
        { shotId: s.id, visual: s.visual, camera: s.camera, seconds },
        async () => {
          await providers.video.generate({
            prompt: `${s.visual}，${s.camera}`,
            outPath: out,
            durationSec: seconds,
            resolution: plan.videoResolution,
          })
        }
      )
    }

    for (const s of picked) {
      for (const [i, line] of s.dialogue.entries()) {
        const voiceId = cast.find((c) => c.id === line.characterId)?.voiceId ?? 'male-qn-qingse'
        const out = run.path('shots', s.id, `voice-${i + 1}.mp3`)
        await spend(
          'voice',
          'tts',
          line.text.length,
          out,
          { shotId: s.id, line: line.text, voiceId },
          async () => {
            await providers.tts.synthesize({ text: line.text, voiceId, outPath: out })
          }
        )
      }
    }
  } catch (err) {
    // 硬上限熔断不是异常退出：把已经完成的产物、账本、进度全部落盘再交回上层。
    if (!(err instanceof BudgetExceededError)) throw err
    stopped = err
    console.log(`  ✋ ${err.message}`)
  }

  await writeJson(run.path('script', 'episode-1.json'), {
    idea: IDEA,
    tier: opts.tier,
    plan,
    shots: picked,
    stopped: stopped ? stopped.message : null,
    artifacts,
  })
  return { ledger, run, artifacts, stopped }
}

function providerNameOf(stage: string, p: ReturnType<typeof createProviders>): string {
  return stage === 'clips' ? p.video.name : stage === 'voice' ? p.tts.name : p.image.name
}

function kindOf(stage: string): 'text' | 'image' | 'video' | 'tts' {
  return stage === 'clips' ? 'video' : stage === 'voice' ? 'tts' : 'image'
}

function modelOf(stage: string, p: ReturnType<typeof createProviders>, plan: StagePlan): string {
  if (stage === 'clips') return `${p.video.model} @${plan.videoResolution}`
  if (stage === 'voice') return `${p.tts.model}（档位提示 ${plan.ttsModelHint}）`
  return p.image.model
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()
  await rm('work', { recursive: true, force: true })
  console.log(`模式：${isMock() ? 'MOCK 离线占位（金额为估算值）' : '真实厂商'}`)
  console.log(`一句话：${IDEA}\n`)

  const wide = new Budget({ softCny: 1e9, hardCny: 1e9 })
  const cache = new ArtifactCache(CACHE_DIR)

  // ① 草稿档
  console.log('① 草稿档跑一集（512P / 每镜 3 秒 / 不出定妆图）')
  const draft = await produceEpisode({ tier: 'draft', cache, budget: wide })
  printPanel('草稿档', draft.ledger)

  // ② 成片档，顺便演示一次「被安全审核拦下的镜头不扣费」
  console.log(
    `\n② 成片档跑同一集（768P / 每镜 6 秒 / 出定妆图）${INJECT.has('blocked') ? '，并注入一次安全审核拦截' : ''}`
  )
  const final1 = await produceEpisode({
    tier: 'final',
    cache,
    budget: wide,
    blockedShotId: INJECT.has('blocked') ? 's02' : undefined,
  })
  printPanel('成片档（首次）', final1.ledger)
  const delta = round(final1.ledger.totalCny - draft.ledger.totalCny)
  console.log(
    `\n  档位对比：草稿 ¥${draft.ledger.totalCny.toFixed(4)} → 成片 ¥${final1.ledger.totalCny.toFixed(4)}，` +
      `贵了 ¥${delta.toFixed(4)}（${((delta / draft.ledger.totalCny) * 100).toFixed(0)}%）。` +
      `质量差别：清晰度 512P→768P，单镜时长 3→6 秒，定妆图 0→${characters().length} 张。`
  )

  // ③ 原样重跑：全部命中缓存
  console.log('\n③ 成片档原样重跑（不改任何输入）')
  const final2 = await produceEpisode({ tier: 'final', cache, budget: wide })
  printPanel('成片档（原样重跑）', final2.ledger)
  console.log(
    `  缓存命中 ${final2.ledger.rows.filter((r) => r.cached).length} / ${final2.ledger.rows.length} 条，` +
      `本次新花费 ¥${final2.ledger.totalCny.toFixed(4)}，省下（估算）¥${final2.ledger.savedByCacheCny.toFixed(4)}`
  )

  // ④ 改一镜的画面描述后重跑：只有受影响的节点重算
  console.log('\n④ 改掉 s02 的画面描述后重跑')
  const final3 = await produceEpisode({
    tier: 'final',
    cache,
    budget: wide,
    visualOfS02: '手机屏幕特写，显示着三分钟后的地铁事故快讯',
  })
  printPanel('成片档（改一镜后重跑）', final3.ledger)
  console.log(
    `  缓存命中 ${final3.ledger.rows.filter((r) => r.cached).length} / ${final3.ledger.rows.length} 条；只有 s02 的首帧与视频需要重算：本次新花费 ¥${final3.ledger.totalCny.toFixed(4)}，` +
      `相比首次 ¥${final1.ledger.totalCny.toFixed(4)} 省下 ¥${round(final1.ledger.totalCny - final3.ledger.totalCny).toFixed(4)}`
  )

  // ⑤ 硬上限熔断：安全停机并保留已完成产物。故障注入，默认不跑。
  if (INJECT.has('overbudget')) {
    console.log('\n⑤ 把硬上限压到 ¥3，清空缓存后再跑成片档（INJECT=overbudget）')
    await rm(CACHE_DIR, { recursive: true, force: true })
    const coldCache = new ArtifactCache(CACHE_DIR)
    const tight = new Budget({
      softCny: 2,
      hardCny: 3,
      onSoft: (spent) =>
        console.log(`  ⚠️ 软上限告警：已花 ¥${spent.toFixed(4)}，超过软上限 ¥2，继续跑但请留意`),
    })
    const halted = await produceEpisode({ tier: 'final', cache: coldCache, budget: tight })
    printPanel('成片档（硬上限 ¥3）', halted.ledger)
    console.log(
      `  已完成产物 ${halted.artifacts.length} 个仍在磁盘上，缓存也已写入：下次带更高预算跑，这些都不用重做。`
    )
  } else {
    console.log('\n⑤ 硬上限熔断演示已跳过。加上 INJECT=overbudget 再跑一次就能看到熔断与安全停机。')
  }

  // ⑥ 软上限触发自动降级：降级不是失败
  console.log('\n⑥ 预算只有 ¥5，先降级再跑（而不是跑一半被砍断）')
  const limit = 5
  const fit = degradeToFit(TIERS.final, (p) => project(p, characters(), shots()), limit)
  const before = project(TIERS.final, characters(), shots())
  console.log(
    `  成片档预估 ¥${before.toFixed(4)}，上限 ¥${limit.toFixed(2)}，${before > limit ? '超了，开始降级：' : '本来就够，无需降级：'}`
  )
  for (const step of fit.applied) console.log(`    - 采纳 ${step}`)
  for (const step of fit.skipped)
    console.log(`    - 跳过 ${step}（这一步在估算表上省不出钱，降了只有损失）`)
  console.log(
    `  降级后预估 ¥${fit.projected.toFixed(4)}，${fit.fits ? '进得去预算，开跑' : '仍然超预算，应该停手并报警'}`
  )
  if (fit.fits) {
    await rm(CACHE_DIR, { recursive: true, force: true })
    const degraded = await produceEpisode({
      tier: 'final',
      plan: fit.plan,
      cache: new ArtifactCache(CACHE_DIR),
      budget: new Budget({ softCny: limit * 0.8, hardCny: limit }),
    })
    printPanel('自动降级后', degraded.ledger)
  }

  // 参考对照：换更贵/更便宜的规格会怎样（纯按公开单价算术，不发任何请求）
  const seconds = shots().reduce((s, x) => s + x.durationSec, 0)
  console.log('\n── 换档位的对照（按公开单价直接算，未调用接口）──')
  console.log(
    `  同样 ${seconds} 秒视频：768P ¥${estimate('video-768p', seconds).toFixed(2)} / 2K ¥${estimate('video-2k', seconds).toFixed(2)} / H3-Max 480P ¥${estimate('video-480p', seconds).toFixed(2)}`
  )
  console.log('  结论：这条线上九成以上的钱在视频，优化顺序永远是「先少调一次视频接口」。')
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
