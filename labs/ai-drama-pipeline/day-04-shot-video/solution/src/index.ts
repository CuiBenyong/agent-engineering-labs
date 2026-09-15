// D4 实验（solution）：由一条分镜数据生成一个可播放的镜头视频。
// 当天要看到的三个现象：
//   1. 轮询日志从 Preparing 一路走到 Success，间隔按指数退避一次比一次长
//   2. 注入一次超时，任务在预算用完的那一刻被放弃，而不是无限等下去
//   3. 失败分类表把六个厂商错误码分别判成重试、改输入、报警三种处置

import 'dotenv/config'
import { ensureFfmpeg } from './ffmpeg.js'
import { createProviders, isMock, type Shot } from './providers/index.js'
import { warnIfPaidOutputInRepo, Run, newRunId, writeJson } from './run.js'
import {
  createVideoTaskApi,
  pollUntilDone,
  TaskTimeoutError,
  type PollOptions,
} from './video-task.js'
import { classify, withRetry, SAMPLE_CODES } from './failures.js'
import { MiniMaxError, PRICE } from './providers/index.js'

const STYLE = '国产都市短剧质感，柔和影棚布光，浅景深，写实人像，竖屏构图，无文字水印'

/** 来自 D2 的分镜数据，本天只用一条。 */
const SHOT: Shot = {
  id: 's01',
  sceneId: 'sc1',
  shotSize: 'medium',
  durationSec: 6,
  characters: ['c1'],
  visual: '雨夜老旧居民楼下，男主蹲在电动车旁，手里握着一部亮着屏的手机',
  camera: '缓慢推近，轻微手持晃动',
  dialogue: [{ characterId: 'c1', text: '这手机怎么自己亮了' }],
}

/**
 * 镜头提示词 = 画面 + 景别 + 运镜 + 风格。
 * 顺序有讲究：先说拍什么，再说怎么拍，最后才是风格，这样截断时丢的是最不重要的一段。
 * prompt_optimizer 默认是 true，会自己改写你的提示词——想要可复现就把它关掉。
 */
const SHOT_SIZE_ZH = { wide: '远景', medium: '中景', close: '特写' } as const

function shotPrompt(shot: Shot): string {
  return `${shot.visual}。${SHOT_SIZE_ZH[shot.shotSize]}，${shot.camera}。${STYLE}`
}

/** 离线跑得快，真实环境要慢得多——两套参数放在一起，读者一眼看到差别。 */
function pollOptions(overrides: Partial<PollOptions> = {}): PollOptions {
  const fast = isMock()
  return {
    timeoutMs: Number(process.env.VIDEO_TIMEOUT_MS ?? (fast ? 30_000 : 15 * 60_000)),
    initialWaitMs: fast ? 200 : 5_000,
    maxWaitMs: fast ? 900 : 20_000,
    factor: 1.5,
    ...overrides,
  }
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()

  const providers = createProviders()
  const api = createVideoTaskApi()
  const run = new Run(newRunId())
  await run.init()

  console.log(`模式：${isMock() ? 'MOCK 离线占位' : `真实厂商 ${api.name} / ${api.model}`}`)
  console.log(`产物目录：${run.dir}\n`)

  // ---- 1. 首帧。完整流水线里这张图来自 D3 的资产库，这里就地生成一张等价的。 ----
  console.log('▸ 1/4 生成首帧（完整流水线里直接取 D3 资产库里的定妆图）')
  const framePath = run.path('shots', SHOT.id, 'first-frame.png')
  const frame = await providers.image.generate({
    prompt: `${SHOT.visual}。${SHOT_SIZE_ZH[SHOT.shotSize]}。${STYLE}`,
    outPath: framePath,
    aspectRatio: '9:16',
  })
  run.record({
    nodeId: 'first-frame',
    provider: providers.image.name as 'mock' | 'minimax',
    kind: 'image',
    model: providers.image.model,
    units: 1,
    costCny: frame.costCny,
    cached: false,
  })
  console.log(`    ✅ ${frame.path}`)

  // ---- 2. 正常路径：提交 → 轮询 → 取件 → 下载 ----
  console.log('\n▸ 2/4 提交任务并轮询（指数退避，间隔一次比一次长）')
  const clipPath = run.path('shots', SHOT.id, 'clip.mp4')
  const prompt = shotPrompt(SHOT)

  const taskId = await withRetry(
    () =>
      api.submit({
        prompt,
        durationSec: SHOT.durationSec,
        firstFrame: framePath,
        resolution: '768P',
      }),
    {
      attempts: 3,
      initialWaitMs: isMock() ? 100 : 2_000,
      maxWaitMs: isMock() ? 400 : 16_000,
      onAttempt: ({ attempt, verdict, waitMs }) =>
        console.log(
          `    ⟳ 第 ${attempt} 次提交失败（${verdict.kind}），${waitMs}ms 后重试：${verdict.reason}`
        ),
    }
  )
  console.log(`    提交成功 task_id=${taskId}`)

  const fileId = await pollUntilDone(
    api,
    taskId,
    pollOptions({
      onTick: ({ attempt, status, elapsedMs, nextWaitMs }) =>
        console.log(
          `    #${attempt} status=${status.padEnd(10)} 已等 ${(elapsedMs / 1000).toFixed(1)}s` +
            (nextWaitMs ? `  下次 ${nextWaitMs}ms 后` : '  ← 终态')
        ),
    })
  )

  const url = await api.retrieve(fileId)
  console.log(`    取件凭证=${fileId}`)
  // 下载地址是临时的，官方没写具体有效期，所以拿到就立刻落盘，不要存进数据库留着以后用。
  await api.download(url, clipPath)
  run.record({
    nodeId: 'clip',
    provider: api.name as 'mock' | 'minimax',
    kind: 'video',
    model: api.model,
    units: SHOT.durationSec,
    costCny: isMock() ? 0 : SHOT.durationSec * 0.5,
    cached: false,
  })
  console.log(`    ✅ 落盘 ${clipPath}`)
  await writeJson(run.path('shots', SHOT.id, 'task.json'), { taskId, fileId, prompt, shot: SHOT })

  // ---- 3. 超时演练：任务永远排队，看预算用完时程序怎么收手 ----
  console.log('\n▸ 3/4 注入一次超时（任务永远停在 Queueing）')
  if (!isMock()) {
    console.log(
      '    跳过：超时注入只在 MOCK=1 下可控，真实环境请用 VIDEO_TIMEOUT_MS 调小预算观察。'
    )
  } else {
    const before = process.env.INJECT
    process.env.INJECT = 'timeout'
    try {
      const stuckId = await api.submit({ prompt, durationSec: SHOT.durationSec })
      await pollUntilDone(
        api,
        stuckId,
        pollOptions({
          timeoutMs: 2_000,
          onTick: ({ attempt, status, elapsedMs, nextWaitMs }) =>
            console.log(
              `    #${attempt} status=${status.padEnd(10)} 已等 ${(elapsedMs / 1000).toFixed(1)}s` +
                (nextWaitMs ? `  下次 ${nextWaitMs}ms 后` : '  ← 预算用完')
            ),
        })
      )
      console.log('    ❌ 预期超时却成功了，检查 pollUntilDone 的超时判断')
    } catch (err) {
      const verdict = classify(err)
      // 判据不是「抛没抛」，是「在预算用完的那一刻抛」：早退等于白等，晚退等于预算形同虚设。
      const budgetMs = 2_000
      const ok = err instanceof TaskTimeoutError && Math.abs(err.waitedMs - budgetMs) <= 600
      console.log(`    ${ok ? '✅' : '❌'} ${err instanceof Error ? err.message : String(err)}`)
      if (!ok && err instanceof TaskTimeoutError) {
        console.log(
          `       预算 ${budgetMs}ms，实际等了 ${err.waitedMs}ms——超时判断没有按时间预算走。`
        )
      }
      console.log(`       分类：${verdict.kind} → ${verdict.disposition}；${verdict.reason}`)
    } finally {
      if (before === undefined) delete process.env.INJECT
      else process.env.INJECT = before
    }
  }

  // ---- 4. 失败分类表 ----
  console.log('\n▸ 4/4 失败分类表')
  console.log('    状态码  含义        类别                   处置')
  for (const { code, note } of SAMPLE_CODES) {
    const v = classify(new MiniMaxError(code, note, '/v1/video_generation'))
    console.log(
      `    ${String(code).padEnd(6)}  ${note.padEnd(8)}  ${v.kind.padEnd(20)}  ${v.disposition}`
    )
  }

  await run.save({ shotId: SHOT.id, taskId, prompt })
  console.log(`\n账单：¥${run.totalCny}（离线模式恒为 0）`)
  console.log(`打开 ${clipPath} 看看这一镜。`)
}

main().catch((err: unknown) => {
  const verdict = classify(err)
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  console.error(`分类：${verdict.kind} → ${verdict.disposition}；${verdict.reason}`)
  process.exitCode = 1
})
