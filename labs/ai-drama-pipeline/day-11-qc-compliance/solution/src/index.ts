// D11 实验（solution）：机器审片 → 自动打回重做 → 前后两道内容安全 → 导出时写入标识并读回。
// 一条命令：MOCK=1 pnpm start

import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensureFfmpeg, ffmpeg } from './ffmpeg.js'
import { SECONDS_PER_HANZI, createProviders, isMock, type Shot } from './providers/index.js'
import { CAST, buildSrt, dialogueOf, draftShots, voiceIdOf } from './script.js'
import { warnIfPaidOutputInRepo, Run, newRunId, writeJson } from './run.js'
import {
  MAX_REDO,
  checkAudioLevel,
  checkAvSync,
  checkResolution,
  checkSubtitleFit,
  createReviewer,
  summarize,
  type CheckResult,
  type ShotQc,
} from './qc.js'
import { checkOutput, checkPrompt, sanitize, type SafetyHit } from './safety.js'
import {
  buildLabel,
  planExplicitLabel,
  prependLabelCue,
  readImplicitLabel,
  writeImplicitLabel,
} from './label.js'

/** 故障注入。本天支持一个取值：lowscore —— 让两镜带着必然不合格的缺陷进来。 */
const INJECT = process.env.INJECT ?? ''

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()
  const run = new Run(newRunId())
  await run.init()
  const providers = createProviders()
  const reviewer = createReviewer(providers.text, isMock())
  const shots = draftShots(INJECT)

  console.log(`模式：${isMock() ? 'MOCK 离线占位' : '真实厂商'}`)
  console.log(
    INJECT === 'lowscore'
      ? '故障注入：lowscore（第二镜台词超长、第三镜构图高风险，都会被质检打回）'
      : '故障注入：无（用 INJECT=lowscore 复现打回重做与止损）'
  )
  console.log(`产物目录：${run.dir}\n`)

  // ---------- 第一道：提示词前置检查 ----------
  console.log('【前置内容安全检查】')
  const blocked: SafetyHit[] = []
  for (const s of shots) {
    const hits = checkPrompt(s.visual)
    if (hits.length === 0) continue
    blocked.push(...hits)
    console.log(`  ⛔ ${s.id} 命中「${hits[0].rule}」：${hits[0].matched}`)
    console.log(`     建议：${hits[0].suggestion}`)
    s.visual = sanitize(s.visual, hits)
    console.log(`     已改写为：${s.visual}`)
  }
  if (blocked.length === 0)
    console.log('  （没有命中，注意这不代表结果一定安全，成片还要再查一遍）')

  // ---------- 定妆图：一致性检查的基准 ----------
  for (const c of CAST) {
    await providers.image.generate({
      prompt: `${c.appearance}，${c.personality}，竖屏人物定妆照`,
      outPath: run.path('assets', 'characters', c.id, 'base.png'),
      aspectRatio: '9:16',
    })
  }

  // ---------- 生成 + 质检 + 打回重做 ----------
  console.log('\n【逐镜生成与质检】')
  const results: ShotQc[] = []
  for (const shot of shots) {
    let redo = 0
    let qc: ShotQc
    for (;;) {
      await produce(shot, redo, run, providers)
      const objective: CheckResult[] = [
        await checkResolution(run.path('shots', shot.id, 'clip.mp4')),
        await checkAvSync(
          run.path('shots', shot.id, 'clip.mp4'),
          run.path('shots', shot.id, 'voice-1.mp3')
        ),
        checkSubtitleFit(dialogueOf(shot), shot.durationSec),
        await checkAudioLevel(run.path('shots', shot.id, 'voice-1.mp3')),
      ]
      qc = summarize(shot.id, [...objective, await reviewer.review(shot, objective)], redo)
      console.log(`  ${shot.id} 第 ${redo + 1} 次：最低分 ${qc.min} → ${qc.verdict}`)
      for (const c of qc.scores)
        console.log(
          `      ${c.score >= 3 ? '·' : '✗'} ${c.id.padEnd(23)} ${c.score} 分  ${c.detail}`
        )
      if (qc.verdict !== 'redo') break
      redo += 1
      autoFix(shot, qc)
      console.log(`      ↻ 自动打回重做（第 ${redo} 次，上限 ${MAX_REDO}）`)
    }
    if (qc.verdict === 'needs-human')
      console.log(`      ⚠️ ${shot.id} 重做 ${qc.redo} 次仍不达标，停手交人工`)
    results.push(qc)
  }

  // ---------- 导出：显式标识 + 隐式标识 ----------
  console.log('\n【导出与标识】')
  await mkdir(run.path('output'), { recursive: true })
  const srt = buildSrt(shots)
  const plan = await planExplicitLabel('本片由 AI 生成合成')
  console.log(`  显式标识：${plan.mode} —— ${plan.note}`)
  const finalSrt = plan.mode === 'subtitle-track' ? prependLabelCue(srt, plan.text) : srt
  await writeFile(run.path('output', 'episode-1.srt'), finalSrt, 'utf8')

  const list = shots.map((s) => `file '${resolve(run.path('shots', s.id, 'clip.mp4'))}'`).join('\n')
  await writeFile(run.path('output', 'concat.txt'), `${list}\n`, 'utf8')
  await ffmpeg(
    [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      run.path('output', 'concat.txt'),
      '-c',
      'copy',
      run.path('output', 'joined.mp4'),
    ],
    { quiet: true }
  )

  const label = buildLabel(run.id, '逐日AI 短剧生产线（教学示例）', [
    providers.image.model,
    providers.video.model,
    providers.tts.model,
  ])
  const outPath = run.path('output', 'episode-1.mp4')
  await writeImplicitLabel({
    videoPath: run.path('output', 'joined.mp4'),
    srtPath: run.path('output', 'episode-1.srt'),
    outPath,
    label,
  })
  const readBack = await readImplicitLabel(outPath)
  console.log(
    `  隐式标识：写入容器元数据后读回 → ${readBack ? `runId=${readBack.runId}，模型 ${readBack.models.join(' / ')}` : '读不出来'}`
  )

  // ---------- 第二道：成片后置检查 ----------
  console.log('\n【后置内容安全检查】')
  const problems = checkOutput({
    subtitles: shots.map(dialogueOf),
    hasImplicitLabel: readBack !== null,
    hasExplicitLabel: finalSrt.includes(plan.text),
  })
  if (problems.length === 0) console.log('  ✅ 成片没有命中词表，两类标识都在')
  for (const p of problems) console.log(`  ⛔ ${p}`)

  await writeJson(run.path('output', 'qc-report.json'), {
    runId: run.id,
    shots: results,
    blockedPrompts: blocked,
    explicitLabel: plan,
    implicitLabel: readBack,
    outputProblems: problems,
  })
  await run.save({
    qc: results.map((r) => ({ shotId: r.shotId, min: r.min, redo: r.redo, verdict: r.verdict })),
  })
  report(results, blocked, readBack !== null, plan.mode, problems, run, INJECT)
}

/** 生成一镜的三样产物。重做时换随机种子，否则同样的输入只会得到同样的结果。 */
async function produce(
  shot: Shot,
  attempt: number,
  run: Run,
  providers: ReturnType<typeof createProviders>
): Promise<void> {
  const frame = run.path('shots', shot.id, 'first-frame.png')
  // 参考图沿用 D3 的做法：把角色定妆图当 subject_reference 传进去，尽量保住同一张脸。
  const reference = run.path('assets', 'characters', shot.characters[0] ?? 'c1', 'base.png')
  await providers.image.generate({
    prompt: `${shot.visual}，${shot.shotSize} 景别`,
    outPath: frame,
    aspectRatio: '9:16',
    seed: 1000 + attempt,
    referenceImage: reference,
  })
  await providers.video.generate({
    prompt: `${shot.visual}，${shot.camera}`,
    outPath: run.path('shots', shot.id, 'clip.mp4'),
    durationSec: shot.durationSec,
    firstFrame: frame,
  })
  await providers.tts.synthesize({
    text: dialogueOf(shot),
    voiceId: voiceIdOf(shot),
    outPath: run.path('shots', shot.id, 'voice-1.mp3'),
  })
}

/** 打回不是「原样再来一次」。每一项不合格都要对应一个具体的修正动作，否则重做多少次都一样。 */
function autoFix(shot: Shot, qc: ShotQc): void {
  for (const c of qc.scores) {
    if (c.score >= 3) continue
    if (c.id === 'subtitle-fit' && shot.dialogue[0]) {
      const room = Math.floor(shot.durationSec / SECONDS_PER_HANZI)
      shot.dialogue[0].text = shot.dialogue[0].text.slice(0, Math.min(20, room))
    }
    if (c.id === 'av-sync')
      shot.durationSec = Math.max(2, Math.round(dialogueOf(shot).length * SECONDS_PER_HANZI))
  }
}

function report(
  results: ShotQc[],
  blocked: SafetyHit[],
  implicit: boolean,
  explicitMode: string,
  problems: string[],
  run: Run,
  inject: string
) {
  console.log('\n质检报告：')
  console.log('  镜头   最低分  重做次数  结论')
  for (const r of results)
    console.log(
      `  ${r.shotId.padEnd(6)} ${String(r.min).padStart(5)}  ${String(r.redo).padStart(7)}  ${r.verdict}`
    )
  console.log(`  报告文件：${run.path('output', 'qc-report.json')}`)

  const checks: [string, boolean][] = [
    ['每一镜都产出了逐项分数', results.every((r) => r.scores.length === 5)],
    ...(inject === 'lowscore'
      ? ([
          ['有镜头因为低分被自动打回并重做', results.some((r) => r.redo > 0)],
          [
            '重做到上限仍不达标的镜头被停手交人工',
            results.some((r) => r.verdict === 'needs-human'),
          ],
        ] as [string, boolean][])
      : ([
          [
            '没有注入缺陷时三镜全部通过（用 INJECT=lowscore 复现打回与止损）',
            results.every((r) => r.verdict === 'pass'),
          ],
        ] as [string, boolean][])),
    ['提示词前置检查拦下了违规描述并给出了替代写法', blocked.length > 0],
    ['成片的容器元数据里能读出隐式标识', implicit],
    [
      `显式标识按能力探测落了地（本机走 ${explicitMode}）`,
      explicitMode === 'burn-in' || explicitMode === 'subtitle-track',
    ],
    ['后置检查没有留下未处理的问题', problems.length === 0],
  ]
  console.log('\n现象核对：')
  for (const [name, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
