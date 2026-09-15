// 世界观档案：一季五集共用的唯一事实来源。
//
// D2 建这份档案，本天用它。跨集一致性不是靠「提示词写得像」保住的，
// 是靠「每一集的提示词都从同一份档案里拼出来」保住的——
// 只要生成提示词的函数只认档案，人物就不会在第三集换一件外套。

import type { Character } from './providers/index.js'

export type World = {
  id: string
  title: string
  logline: string
  /** 风格词：每一镜的图像与视频提示词都必须带上，跨集画风才不会漂 */
  styleTokens: string[]
  cast: Character[]
}

export const WORLD: World = {
  id: 'w-phone',
  title: '预知五分钟',
  logline: '一个外卖骑手捡到一部能提前五分钟推送新闻的手机，靠它救人，也被它拖进别人的局。',
  styleTokens: ['竖屏 9:16', '雨夜霓虹', '低饱和冷色调', '手持轻微晃动'],
  cast: [
    {
      id: 'c1',
      name: '林野',
      appearance: '二十五岁男性，短发，蓝色外卖工服，右眉有一道旧疤',
      personality: '嘴硬心软',
      voiceId: 'junlang_nanyou',
    },
    {
      id: 'c2',
      name: '苏晓',
      appearance: '二十三岁女性，长发，米色针织衫，戴细框眼镜',
      personality: '冷静敏锐',
      voiceId: 'danya_xuejie',
    },
    {
      id: 'c3',
      name: '周叔',
      appearance: '五十岁男性，花白短发，深灰夹克，左手戴旧手表',
      personality: '话少，护着人',
      voiceId: 'lengdan_xiongzhang',
    },
  ],
}

export type EpisodePlan = {
  n: number
  title: string
  /** 上一集留下的钩子，必须出现在本集第一镜的铺垫里 */
  pickUp: string | null
  /** 本集留给下一集的钩子 */
  hook: string
  shots: {
    id: string
    sceneId: string
    shotSize: 'wide' | 'medium' | 'close'
    durationSec: number
    characters: string[]
    visual: string
    camera: string
    dialogue: { characterId: string; text: string }[]
  }[]
  /** 这一集是否需要人工过一遍（整季账单要统计人工介入次数） */
  needsReview: boolean
}

export const SEASON: EpisodePlan[] = [
  {
    n: 1,
    title: '捡到',
    pickUp: null,
    hook: '手机推送了一条明天的讣告，名字是苏晓',
    needsReview: false,
    shots: [
      {
        id: 'e1s01',
        sceneId: 'sc1',
        shotSize: 'wide',
        durationSec: 4,
        characters: ['c1'],
        visual: '雨夜的老旧居民楼下，林野蹲在电动车旁翻看一部亮着的手机',
        camera: '缓慢推近',
        dialogue: [{ characterId: 'c1', text: '这手机怎么自己亮了' }],
      },
      {
        id: 'e1s02',
        sceneId: 'sc1',
        shotSize: 'close',
        durationSec: 4,
        characters: ['c1'],
        visual: '手机屏幕特写，一条五分钟后才该出现的新闻推送',
        camera: '固定机位',
        dialogue: [{ characterId: 'c1', text: '五分钟后？这不可能' }],
      },
    ],
  },
  {
    n: 2,
    title: '讣告',
    pickUp: '手机推送了一条明天的讣告，名字是苏晓',
    hook: '苏晓说这部手机原本是她父亲的',
    needsReview: false,
    shots: [
      {
        id: 'e2s01',
        sceneId: 'sc2',
        shotSize: 'medium',
        durationSec: 4,
        characters: ['c1'],
        visual: '便利店灯下，林野反复刷新那条写着苏晓名字的讣告推送',
        camera: '轻微手持',
        dialogue: [{ characterId: 'c1', text: '明天的讣告，为什么会有名字' }],
      },
      {
        id: 'e2s02',
        sceneId: 'sc2',
        shotSize: 'close',
        durationSec: 4,
        characters: ['c1', 'c2'],
        visual: '便利店门口，苏晓拦下正要离开的林野',
        camera: '横移跟拍',
        dialogue: [{ characterId: 'c2', text: '那部手机，不是你的' }],
      },
    ],
  },
  {
    n: 3,
    title: '父亲的表',
    pickUp: '苏晓说这部手机原本是她父亲的',
    hook: '周叔手上那只旧手表，和讣告照片里的是同一只',
    needsReview: false,
    shots: [
      {
        id: 'e3s01',
        sceneId: 'sc3',
        shotSize: 'medium',
        durationSec: 4,
        characters: ['c2', 'c3'],
        visual: '旧居的客厅，苏晓把父亲的手机推到周叔面前',
        camera: '固定机位',
        dialogue: [{ characterId: 'c2', text: '我爸最后一通电话是打给你的' }],
      },
      {
        id: 'e3s02',
        sceneId: 'sc3',
        shotSize: 'close',
        durationSec: 4,
        characters: ['c3'],
        visual: '周叔左手腕旧手表的特写，表盘裂了一道',
        camera: '缓慢下摇',
        dialogue: [{ characterId: 'c3', text: '这表，本来该跟他一起走' }],
      },
    ],
  },
  {
    n: 4,
    title: '同一只表',
    pickUp: '周叔手上那只旧手表，和讣告照片里的是同一只',
    hook: '手机开始推送林野自己的名字',
    needsReview: true,
    shots: [
      {
        id: 'e4s01',
        sceneId: 'sc4',
        shotSize: 'wide',
        durationSec: 4,
        characters: ['c1', 'c3'],
        visual: '雨中的天桥下，林野把手表还给周叔',
        camera: '缓慢推近',
        dialogue: [{ characterId: 'c3', text: '你越用它，它就越要收回去' }],
      },
      {
        id: 'e4s02',
        sceneId: 'sc4',
        shotSize: 'close',
        durationSec: 4,
        characters: ['c1'],
        visual: '手机屏幕特写，推送标题里出现了林野三个字',
        camera: '固定机位',
        dialogue: [{ characterId: 'c1', text: '这次是我' }],
      },
    ],
  },
  {
    n: 5,
    title: '关机',
    pickUp: '手机开始推送林野自己的名字',
    hook: '关机的第二天，苏晓的手机亮了',
    needsReview: false,
    shots: [
      {
        id: 'e5s01',
        sceneId: 'sc5',
        shotSize: 'medium',
        durationSec: 4,
        characters: ['c1', 'c2'],
        visual: '天台边缘，林野把还在推送的手机递给苏晓',
        camera: '横移跟拍',
        dialogue: [{ characterId: 'c1', text: '这次别按接受' }],
      },
      {
        id: 'e5s02',
        sceneId: 'sc5',
        shotSize: 'close',
        durationSec: 4,
        characters: ['c2'],
        visual: '苏晓按下关机键，屏幕暗下去',
        camera: '固定机位',
        dialogue: [{ characterId: 'c2', text: '我替我爸关一次' }],
      },
    ],
  },
]

/** 提示词只从档案里拼：角色外貌逐字取 cast，风格词逐条附加。 */
export function imagePrompt(world: World, shot: EpisodePlan['shots'][number]): string {
  const who = shot.characters
    .map((id) => world.cast.find((c) => c.id === id))
    .filter((c): c is Character => Boolean(c))
    .map((c) => `${c.name}（${c.appearance}）`)
    .join('，')
  return [shot.visual, who, `${shot.shotSize} 景别`, ...world.styleTokens]
    .filter(Boolean)
    .join('，')
}

export function videoPrompt(world: World, shot: EpisodePlan['shots'][number]): string {
  return [imagePrompt(world, shot), shot.camera].join('，')
}
