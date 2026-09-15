// D1 实验（starter）：一句话进，一条任务图跑完，一个目录的素材出。
// 全文有 4 个编号练习：providers/mock.ts 里两个、dag.ts 里一个、本文件末尾时间轴节点一个。
// 这一天不追求成片质量，只追求三件事：图跑通、产物落盘、离线与真实两条路共用同一份业务代码。

import 'dotenv/config'
import { ensureFfmpeg } from './ffmpeg.js'
import { createProviders, isMock, type Character, type Shot } from './providers/index.js'
import { runGraph, type NodeReport, type TaskNode } from './dag.js'
import { warnIfPaidOutputInRepo, Run, newRunId, writeJson } from './run.js'

const IDEA = process.argv.slice(2).join(' ') || '外卖小哥捡到一部会预知未来的手机'

/** D1 先用写死的人物与分镜，D2 会换成剧本 Agent 生成。 */
function draftCharacters(): Character[] {
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

function draftShots(idea: string): Shot[] {
  return [
    {
      id: 's01',
      sceneId: 'sc1',
      shotSize: 'wide',
      durationSec: 6,
      characters: ['c1'],
      visual: `雨夜的老旧居民楼下，${idea}的开场，男主蹲在电动车旁`,
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
      durationSec: 6,
      characters: ['c1', 'c2'],
      visual: '便利店门口，女主拦下正要离开的男主',
      camera: '横移跟拍',
      dialogue: [{ characterId: 'c2', text: '那部手机，不是你的' }],
    },
  ]
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()

  const providers = createProviders()
  const run = new Run(newRunId())
  await run.init()

  console.log(`模式：${isMock() ? 'MOCK 离线占位' : `真实厂商 ${providers.image.name}`}`)
  console.log(`一句话：${IDEA}`)
  console.log(`产物目录：${run.dir}\n`)

  const characters = draftCharacters()
  const shots = draftShots(IDEA)

  const nodes: TaskNode[] = [
    {
      id: 'script',
      title: '剧本与人物卡',
      deps: [],
      run: async () => {
        await writeJson(run.path('script', 'characters.json'), characters)
        await writeJson(run.path('script', 'episode-1.json'), { idea: IDEA, shots })
        return {
          artifacts: [run.path('script', 'characters.json'), run.path('script', 'episode-1.json')],
        }
      },
    },
    {
      id: 'assets',
      title: '角色定妆图',
      deps: ['script'],
      run: async () => {
        const artifacts: string[] = []
        for (const c of characters) {
          const out = run.path('assets', 'characters', c.id, 'base.png')
          const r = await providers.image.generate({
            prompt: `${c.appearance}，${c.personality}，竖屏人物定妆照`,
            outPath: out,
          })
          run.record({
            nodeId: 'assets',
            provider: providers.image.name as 'mock' | 'minimax',
            kind: 'image',
            model: providers.image.model,
            units: 1,
            costCny: r.costCny,
            cached: false,
          })
          artifacts.push(r.path)
        }
        return { artifacts }
      },
    },
    {
      id: 'frames',
      title: '每镜首帧',
      deps: ['assets'],
      run: async () => {
        const artifacts: string[] = []
        for (const s of shots) {
          const out = run.path('shots', s.id, 'first-frame.png')
          const r = await providers.image.generate({
            prompt: `${s.visual}，${s.shotSize} 景别`,
            outPath: out,
          })
          run.record({
            nodeId: 'frames',
            provider: providers.image.name as 'mock' | 'minimax',
            kind: 'image',
            model: providers.image.model,
            units: 1,
            costCny: r.costCny,
            cached: false,
          })
          artifacts.push(r.path)
        }
        return { artifacts }
      },
    },
    {
      id: 'clips',
      title: '镜头视频',
      deps: ['frames'],
      run: async () => {
        const artifacts: string[] = []
        for (const s of shots) {
          const out = run.path('shots', s.id, 'clip.mp4')
          const r = await providers.video.generate({
            prompt: `${s.visual}，${s.camera}`,
            outPath: out,
            durationSec: s.durationSec,
          })
          run.record({
            nodeId: 'clips',
            provider: providers.video.name as 'mock' | 'minimax',
            kind: 'video',
            model: providers.video.model,
            units: s.durationSec,
            costCny: r.costCny,
            cached: false,
          })
          artifacts.push(r.path)
        }
        return { artifacts }
      },
    },
    {
      id: 'voice',
      title: '台词配音',
      deps: ['script'],
      run: async () => {
        const artifacts: string[] = []
        for (const s of shots) {
          for (const [i, line] of s.dialogue.entries()) {
            const voiceId =
              characters.find((c) => c.id === line.characterId)?.voiceId ?? 'male-qn-qingse'
            const out = run.path('shots', s.id, `voice-${i + 1}.mp3`)
            const r = await providers.tts.synthesize({ text: line.text, voiceId, outPath: out })
            run.record({
              nodeId: 'voice',
              provider: providers.tts.name as 'mock' | 'minimax',
              kind: 'tts',
              model: providers.tts.model,
              units: r.usageCharacters,
              costCny: r.costCny,
              cached: false,
            })
            artifacts.push(r.path)
          }
        }
        return { artifacts }
      },
    },
    {
      id: 'timeline',
      title: '时间轴',
      deps: ['clips', 'voice'],
      run: async () => {
        // 练习 4：算出每一镜在成片里的起止时间。
        //   规则：第一镜从 0 开始，后一镜的 startMs 等于前一镜的 endMs，
        //        每一镜占 durationSec 秒（毫秒要乘 1000），最后把总时长写进 note。
        //   现在所有镜头都从 0 开始，时间轴是叠在一起的——
        //   打开 work/runs/<runId>/timeline/episode-1.json 一眼就能看到。
        const entries = shots.map((s) => ({
          shotId: s.id,
          startMs: 0,
          endMs: s.durationSec * 1000,
          clipPath: run.path('shots', s.id, 'clip.mp4'),
          voicePath: run.path('shots', s.id, 'voice-1.mp3'),
          subtitle: s.dialogue[0]?.text,
        }))
        const out = run.path('timeline', 'episode-1.json')
        await writeJson(out, entries)
        return { artifacts: [out], note: '总时长 待实现（练习 4）' }
      },
    },
  ]

  const reports = await runGraph(nodes)
  await run.save({ idea: IDEA, nodes: reports })
  printSummary(reports, run)
}

function printSummary(reports: NodeReport[], run: Run) {
  const totalMs = reports.reduce((s, r) => s + r.ms, 0)
  const artifacts = reports.reduce((s, r) => s + r.artifacts.length, 0)
  console.log('\n账单：')
  for (const r of reports)
    console.log(`  ${r.id.padEnd(10)} ${String(r.ms).padStart(6)}ms  产物 ${r.artifacts.length}`)
  console.log(
    `  ${'合计'.padEnd(9)} ${String(totalMs).padStart(6)}ms  产物 ${artifacts}  花费 ¥${run.totalCny}`
  )
  console.log(`\n打开 ${run.path('shots', 's01', 'clip.mp4')} 看看第一镜。`)
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
