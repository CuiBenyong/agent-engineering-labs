// 样例剧本与调用计数器。审核台本身不关心剧本内容，把它们放在这里让 store.ts 只剩状态逻辑。

import type { Character, Providers, Shot } from './providers/index.js'

export const CAST: Character[] = [
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

export function draftShots(): Shot[] {
  return [
    {
      id: 's01',
      sceneId: 'sc1',
      shotSize: 'wide',
      durationSec: 4,
      characters: ['c1'],
      visual: '雨夜居民楼下，男主蹲在电动车旁翻找那部手机',
      camera: '缓慢推近',
      dialogue: [{ characterId: 'c1', text: '这手机怎么又亮了' }],
    },
    {
      id: 's02',
      sceneId: 'sc1',
      shotSize: 'close',
      durationSec: 4,
      characters: ['c1'],
      visual: '手机屏幕特写，显示着五分钟后的新闻推送',
      camera: '固定机位',
      dialogue: [{ characterId: 'c1', text: '五分钟后？这不可能' }],
    },
    {
      id: 's03',
      sceneId: 'sc2',
      shotSize: 'medium',
      durationSec: 4,
      characters: ['c1', 'c2'],
      visual: '便利店门口，女主把伞举到男主头顶',
      camera: '横移跟拍',
      dialogue: [{ characterId: 'c2', text: '那部手机，不是你的' }],
    },
  ]
}

/** 调用计数器：证明「只重跑了受影响节点」最硬的证据是**接口一次都没被调**。 */
export type CallCounter = { text: number; image: number; video: number; tts: number }

export function countCalls(p: Providers, c: CallCounter): Providers {
  return {
    text: {
      name: p.text.name,
      model: p.text.model,
      complete: (i) => {
        c.text += 1
        return p.text.complete(i)
      },
    },
    image: {
      name: p.image.name,
      model: p.image.model,
      generate: (i) => {
        c.image += 1
        return p.image.generate(i)
      },
    },
    video: {
      name: p.video.name,
      model: p.video.model,
      generate: (i) => {
        c.video += 1
        return p.video.generate(i)
      },
    },
    tts: {
      name: p.tts.name,
      model: p.tts.model,
      synthesize: (i) => {
        c.tts += 1
        return p.tts.synthesize(i)
      },
    },
  }
}
