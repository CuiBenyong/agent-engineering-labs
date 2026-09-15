// 把「一集」展开成若干条带依赖的任务，并在每次调用 provider 之前穿过对应的闸门。
// 业务不变：还是 D1 那条 script → frame/voice → clip → timeline 的图；
// 变的是每一步都要先问闸门要许可，以及视频这一步不再占着工作槽等。

import { MiniMaxError, type Character, type Providers, type Shot } from './providers/index.js'
import type { Priority, Task } from './queue.js'
import { Run, writeJson } from './run.js'

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

export function draftShots(ep: number): Shot[] {
  return [
    {
      id: `e${ep}s01`,
      sceneId: `e${ep}sc1`,
      shotSize: 'wide',
      durationSec: 4,
      characters: ['c1'],
      visual: `第 ${ep} 集开场：雨夜居民楼下，男主蹲在电动车旁翻找那部手机`,
      camera: '缓慢推近',
      dialogue: [{ characterId: 'c1', text: '这手机怎么又亮了' }],
    },
    {
      id: `e${ep}s02`,
      sceneId: `e${ep}sc2`,
      shotSize: 'close',
      durationSec: 4,
      characters: ['c2'],
      visual: `第 ${ep} 集转折：便利店门口，女主把伞举到男主头顶`,
      camera: '固定机位',
      dialogue: [{ characterId: 'c2', text: '那部手机，不是你的' }],
    },
    {
      id: `e${ep}s03`,
      sceneId: `e${ep}sc2`,
      shotSize: 'medium',
      durationSec: 4,
      characters: ['c1', 'c2'],
      visual: `第 ${ep} 集悬念：两人对视，屏幕在雨里再次亮起`,
      camera: '横移跟拍',
      dialogue: [{ characterId: 'c1', text: '你到底是谁' }],
    },
  ]
}

/**
 * 注入限流：让前几次调用返回 status_code=1002。
 * 这是本实验唯一的「假」——它假的是厂商的回应，不是我们的处理逻辑。
 */
export function injectRateLimit(
  providers: Providers,
  budget: Record<'image' | 'tts', number>
): Providers {
  const bite = (kind: 'image' | 'tts', endpoint: string) => {
    if (budget[kind] <= 0) return
    budget[kind] -= 1
    throw new MiniMaxError(1002, 'rate limit exceeded (injected)', endpoint)
  }
  return {
    ...providers,
    image: {
      name: providers.image.name,
      model: providers.image.model,
      generate: async (input) => {
        bite('image', '/v1/image_generation')
        return providers.image.generate(input)
      },
    },
    tts: {
      name: providers.tts.name,
      model: providers.tts.model,
      synthesize: async (input) => {
        bite('tts', '/v1/t2a_v2')
        return providers.tts.synthesize(input)
      },
    },
  }
}

export type JobDeps = {
  run: Run
  providers: Providers
}

export function buildEpisodeTasks(ep: number, priority: Priority, d: JobDeps): Task[] {
  const shots = draftShots(ep)
  const tag = `ep${ep}`
  const tasks: Task[] = [
    {
      id: `${tag}-script`,
      episode: tag,
      label: '剧本',
      priority,
      deps: [],
      gate: 'text',
      attempt: 0,
      start: async () => {
        const r = await d.providers.text.complete({ user: `把第 ${ep} 集的两个分镜润色一遍` })
        await writeJson(d.run.path('script', `episode-${ep}.json`), { ep, note: r.text, shots })
        d.run.record({
          nodeId: `${tag}-script`,
          provider: d.providers.text.name as 'mock' | 'minimax',
          kind: 'text',
          model: d.providers.text.model,
          units: r.completionTokens,
          costCny: 0,
          cached: false,
        })
        return undefined
      },
    },
  ]

  for (const s of shots) {
    tasks.push({
      id: `${tag}-frame-${s.id}`,
      episode: tag,
      label: '首帧',
      priority,
      deps: [`${tag}-script`],
      gate: 'image',
      attempt: 0,
      start: async () => {
        const out = d.run.path('shots', s.id, 'first-frame.png')
        await d.providers.image.generate({
          prompt: `${s.visual}，${s.shotSize} 景别`,
          outPath: out,
          aspectRatio: '9:16',
        })
        return undefined
      },
    })
    tasks.push({
      id: `${tag}-voice-${s.id}`,
      episode: tag,
      label: '配音',
      priority,
      deps: [`${tag}-script`],
      gate: 'tts',
      attempt: 0,
      start: async () => {
        const line = s.dialogue[0]
        if (!line) return undefined
        const voiceId = CAST.find((c) => c.id === line.characterId)?.voiceId ?? 'male-qn-qingse'
        const out = d.run.path('shots', s.id, 'voice-1.mp3')
        await d.providers.tts.synthesize({ text: line.text, voiceId, outPath: out })
        return undefined
      },
    })
    tasks.push({
      id: `${tag}-clip-${s.id}`,
      episode: tag,
      label: '镜头视频（长任务）',
      priority,
      deps: [`${tag}-frame-${s.id}`],
      gate: 'video',
      attempt: 0,
      start: async () => {
        const out = d.run.path('shots', s.id, 'clip.mp4')
        // 练习 5：把长任务改成「提交完就还工作槽」。
        // 现在这一行 await 会让这条执行流一直陪着视频等——真实的视频任务要跑好几分钟。
        // 提示：不要 await，把 promise 包进一个函数 return 出去，调度器会在后台等它。
        //       闸门的票不受影响，它要一直占到厂商真的返回为止。
        await d.providers.video.generate({
          prompt: `${s.visual}，${s.camera}`,
          outPath: out,
          durationSec: s.durationSec,
          firstFrame: d.run.path('shots', s.id, 'first-frame.png'),
        })
        d.run.record({
          nodeId: `${tag}-clip-${s.id}`,
          provider: d.providers.video.name as 'mock' | 'minimax',
          kind: 'video',
          model: d.providers.video.model,
          units: s.durationSec,
          costCny: 0,
          cached: false,
        })
        return undefined
      },
    })
  }

  tasks.push({
    id: `${tag}-timeline`,
    episode: tag,
    label: '时间轴',
    priority,
    attempt: 0,
    deps: shots.flatMap((s) => [`${tag}-clip-${s.id}`, `${tag}-voice-${s.id}`]),
    start: async () => {
      let cursor = 0
      const entries = shots.map((s) => {
        const startMs = cursor
        cursor += s.durationSec * 1000
        return {
          shotId: s.id,
          startMs,
          endMs: cursor,
          clipPath: d.run.path('shots', s.id, 'clip.mp4'),
          voicePath: d.run.path('shots', s.id, 'voice-1.mp3'),
          subtitle: s.dialogue[0]?.text,
        }
      })
      await writeJson(d.run.path('timeline', `episode-${ep}.json`), entries)
      return undefined
    },
  })

  return tasks
}
