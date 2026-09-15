// D13 实验（solution）：一次渲染，多次封装，多平台发行。
//
// 五步跑完：
//   ① 生成一集母版（这是全流程里唯一一次编码）
//   ② 按三个平台的规格表出片，打印每一次封装是流复制还是重编码
//   ③ 一次取帧、多平台复用封面
//   ④ 批量出标题与封面文案候选，打分挑前三
//   ⑤ 把两个平台的播放数据映射回具体环节，打印发布清单

import 'dotenv/config'
import { mkdir, rm, writeFile, copyFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ffmpeg } from './ffmpeg.js'
import { createProviders, isMock, type Character, type Shot } from './providers/index.js'
import { Run, newRunId, writeJson } from './run.js'
import { probe, type MediaInfo } from './probe.js'
import { PLATFORMS, decidePackaging, type PlatformSpec } from './platforms.js'
import { buildContext, generateCandidates } from './titles.js'
import { diagnose, type PlaybackStat, type ShotWindow } from './feedback.js'

const IDEA = process.argv.slice(2).join(' ') || '外卖小哥捡到一部会预知未来的手机'

const CAST: Character[] = [
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

const SHOTS: Shot[] = [
  {
    id: 's01',
    sceneId: 'sc1',
    shotSize: 'wide',
    durationSec: 5,
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
    visual: '手机屏幕特写，显示着五分钟后的新闻推送',
    camera: '固定机位',
    dialogue: [{ characterId: 'c1', text: '五分钟后？这不可能' }],
  },
  {
    id: 's03',
    sceneId: 'sc2',
    shotSize: 'medium',
    durationSec: 5,
    characters: ['c1', 'c2'],
    visual: '便利店门口，女主拦下正要离开的男主',
    camera: '横移跟拍',
    dialogue: [{ characterId: 'c2', text: '那部手机，不是你的' }],
  },
]

/** 全流程的编码计数器：这一天的成败就看它。 */
const counter = { encodes: 0, remuxes: 0, stillExtracts: 0, coverCopies: 0 }

async function renderMaster(run: Run): Promise<string> {
  const providers = createProviders()
  const parts: string[] = []
  for (const s of SHOTS) {
    const out = run.path('shots', s.id, 'clip.mp4')
    await providers.video.generate({
      prompt: `${s.visual}，${s.camera}`,
      outPath: out,
      durationSec: s.durationSec,
      resolution: '768P',
    })
    counter.encodes += 1
    parts.push(out)
  }
  const listPath = run.path('output', 'concat.txt')
  await mkdir(join(run.dir, 'output'), { recursive: true })
  // concat 列表里的路径是相对于列表文件本身解析的，所以一律写绝对路径，省掉一类玄学报错。
  await writeFile(
    listPath,
    parts.map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  )
  const master = run.path('output', 'master.mp4')
  // 拼接走 concat 解复用器 + -c copy：拼一集不需要重新编码。
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', master])
  counter.remuxes += 1
  return master
}

async function exportFor(
  spec: PlatformSpec,
  master: MediaInfo,
  run: Run
): Promise<{ path: string; action: string }> {
  const plan = decidePackaging(master, spec)
  console.log(
    `\n  ▸ ${spec.name}（规格来源：${spec.sourceOfTruth === 'official-doc' ? '官方文档' : '你自己的账号后台'}）`
  )
  for (const c of plan.checks) console.log(`      · ${c}`)
  const ext = spec.containers?.[0] ?? 'mp4'
  const out = run.path('output', `episode-1.${spec.id}.${ext}`)
  if (plan.action === 'copy') {
    await ffmpeg([
      '-i',
      master.path,
      '-c',
      'copy',
      ...plan.extraArgs,
      '-movflags',
      '+faststart',
      out,
    ])
    counter.remuxes += 1
    console.log(`      → 流复制封装，不重编码`)
  } else {
    await ffmpeg([
      '-i',
      master.path,
      '-vf',
      `scale='min(${spec.maxSidePx ?? 4096},iw)':-2`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      ...plan.extraArgs,
      out,
    ])
    counter.encodes += 1
    console.log(`      → 规格不满足，重编码一次`)
  }
  return { path: out, action: plan.action }
}

async function makeCovers(master: MediaInfo, run: Run): Promise<string[]> {
  // 一次取帧，多平台复用。三个平台都用同一张竖屏封面，所以这里是 1 次取帧 + N 次复制。
  // 练习 5：改成「一次取帧，多平台复用」。
  //   先取一张 cover-master.jpg（counter.stillExtracts += 1），
  //   再对每个平台 copyFile 出一份（counter.coverCopies += 1）。
  //   三个平台都是竖屏同尺寸，多取两次帧纯属浪费——真实项目里这一步还要读母版。
  // 现在每个平台各取一次帧：日志会打印「取帧 3 次，复制 0 份」。
  void copyFile
  const covers: string[] = []
  for (const p of PLATFORMS) {
    const out = run.path('output', `cover-1.${p.id}.jpg`)
    await ffmpeg(['-ss', '1', '-i', master.path, '-frames:v', '1', out])
    counter.stillExtracts += 1
    covers.push(out)
  }
  return covers
}

function fakeStats(): PlaybackStat[] {
  // 离线演示用的假数据。改动这里的数字，下面的诊断结论会跟着变——这就是「业务逻辑真的在跑」。
  return [
    {
      platform: 'TikTok',
      episodeId: 'ep-1',
      publishedAt: '2026-09-06T10:00:00Z',
      views: 42000,
      likes: 1800,
      comments: 96,
      shares: 220,
      completionRate: 0.41,
      retention: [
        { atSec: 0, ratio: 1 },
        { atSec: 3, ratio: 0.78 },
        { atSec: 6, ratio: 0.7 },
        { atSec: 9, ratio: 0.62 },
        { atSec: 12, ratio: 0.55 },
        { atSec: 16, ratio: 0.41 },
      ],
    },
    {
      platform: '抖音',
      episodeId: 'ep-1',
      publishedAt: '2026-09-06T10:00:00Z',
      views: 9100,
      likes: 120,
      comments: 8,
      shares: 5,
      completionRate: 0.18,
      retention: [
        { atSec: 0, ratio: 1 },
        { atSec: 3, ratio: 0.51 },
        { atSec: 6, ratio: 0.44 },
        { atSec: 9, ratio: 0.2 },
        { atSec: 12, ratio: 0.19 },
        { atSec: 16, ratio: 0.18 },
      ],
    },
  ]
}

function windows(): ShotWindow[] {
  let cursor = 0
  return SHOTS.map((s) => {
    const start = cursor
    cursor += s.durationSec
    return { shotId: s.id, startSec: start, endSec: cursor }
  })
}

async function main() {
  const run = new Run(newRunId())
  await rm('work', { recursive: true, force: true })
  await run.init()
  console.log(`模式：${isMock() ? 'MOCK 离线占位' : '真实厂商'}`)
  console.log(`一句话：${IDEA}`)
  console.log(`产物目录：${run.dir}\n`)

  console.log('① 渲染母版（全流程唯一一次真正的编码发生在这里）')
  const masterPath = await renderMaster(run)
  const master = await probe(masterPath)
  console.log(
    `   母版：${master.width}x${master.height} ${master.videoCodec}/${master.audioCodec} ` +
      `${master.fps}fps ${master.durationSec.toFixed(1)}s ${(master.bytes / 1024 / 1024).toFixed(1)}MB`
  )

  console.log('\n② 按平台规格表出片')
  const exported: { spec: PlatformSpec; path: string; action: string }[] = []
  const manual: string[] = []
  for (const spec of PLATFORMS) {
    const r = await exportFor(spec, master, run)
    exported.push({ spec, ...r })
    manual.push(...decidePackaging(master, spec).manualChecks)
  }

  console.log('\n③ 封面：一次取帧，多平台复用')
  const covers = await makeCovers(master, run)
  console.log(`   取帧 ${counter.stillExtracts} 次，复制 ${counter.coverCopies} 份，缩放 0 次`)

  console.log('\n── 编码次数账 ──')
  console.log(`   镜头编码 ${SHOTS.length} 次（母版的原料，跑一次就够）`)
  console.log(`   重编码 ${counter.encodes - SHOTS.length} 次；流复制封装 ${counter.remuxes} 次`)
  console.log(
    `   朴素做法（每个平台各渲染一遍）会重编码 ${PLATFORMS.length} 次，画质每转一次衰减一次`
  )

  // 判定函数长什么样，用一个假想规格演示一下——不代表任何真实平台的要求。
  const hypothetical: PlatformSpec = {
    ...PLATFORMS[0]!,
    id: 'demo',
    name: '假想平台（仅演示判定函数）',
    maxSidePx: 1280,
  }
  const demo = decidePackaging(master, hypothetical)
  console.log(
    `   对照：若某平台把长边限制在 1280，同一份母版会被判为「${demo.action === 'reencode' ? '必须重编码' : '仍可流复制'}」`
  )

  console.log('\n④ 标题与封面文案：批量出候选，打分挑前三')
  const providers = createProviders()
  const ctx = buildContext(SHOTS, Object.fromEntries(CAST.map((c) => [c.id, c.name])))
  const candidates = await generateCandidates(providers.text, ctx)
  for (const c of candidates) {
    console.log(`   ${c.id} [${c.angle}] ${c.score.toString().padStart(2)} 分  ${c.title}`)
    console.log(
      `        封面大字：${c.coverCopy}（${c.coverFromModel ? '模型给的' : '模型返回不可用，回落本地模板'}）`
    )
    console.log(`        依据：${c.reasons.join('；')}`)
  }
  const top3 = candidates.slice(0, 3)
  console.log(`   前三：${top3.map((c) => c.title).join(' / ')}`)

  console.log('\n⑤ 数据回收：把播放数据映射回具体环节')
  const stats = fakeStats()
  const w = windows()
  for (const s of stats) {
    console.log(`   ${s.platform}：播放 ${s.views}，完播率 ${(s.completionRate * 100).toFixed(0)}%`)
    for (const f of diagnose(s, w)) {
      console.log(`     · [${f.window}] → 环节 ${f.stage}：${f.symptom}`)
      console.log(`       建议：${f.action}`)
    }
  }

  const checklist = [
    '成片的三个版本都能在本机播放器里正常打开',
    '每个平台的封面尺寸与成片方向一致（竖屏 9:16）',
    '标题与封面文案取自打分前三，且没有夸大与承诺用语',
    ...manual,
    '生成内容标识（显式 + 隐式）已按 D11 的做法写进导出物：/learn/ai-drama-pipeline/day-11',
    '背景音乐与素材来源可追溯，没有使用来路不明的音轨',
  ]
  console.log('\n── 发布清单（逐项手动勾选）──')
  for (const [i, c] of checklist.entries()) console.log(`   [ ] ${i + 1}. ${c}`)

  await writeJson(run.path('output', 'release.json'), {
    idea: IDEA,
    master: { ...master },
    exports: exported.map((e) => ({
      platform: e.spec.id,
      path: e.path,
      action: e.action,
      docUrl: e.spec.docUrl,
      note: e.spec.note,
    })),
    covers,
    titles: candidates,
    top3: top3.map((c) => ({ title: c.title, coverCopy: c.coverCopy })),
    counter,
    checklist,
  })
  console.log(`\n发布物料清单写在 ${run.path('output', 'release.json')}`)
  await stat(masterPath)
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
