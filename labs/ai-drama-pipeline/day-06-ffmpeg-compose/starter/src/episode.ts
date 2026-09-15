// 本天的输入素材：分镜、人物卡、角色基调。
// 完整流水线里这三份来自 D2 的剧本 Agent、D3 的资产库与 D5 的音色分配，
// D6 只关心「素材已经有了」之后怎么剪，所以这里写死，且与 D5 用的是同一集。

import type { Character, Shot } from './providers/index.js'
import type { Emotion } from './voice.js'

export const CHARACTERS: Character[] = [
  {
    id: 'c1',
    name: '林野',
    appearance: '二十五岁男性，蓝色外卖工服',
    personality: '嘴硬心软',
    voiceId: 'junlang_nanyou',
  },
  {
    id: 'c2',
    name: '苏晓',
    appearance: '二十三岁女性，米色针织衫',
    personality: '冷静敏锐',
    voiceId: 'danya_xuejie',
  },
]

/** 角色基调：情绪与语速。来自 D5，本天不改。 */
export const MOODS: Record<string, { emotion: Emotion; speed: number }> = {
  c1: { emotion: 'calm', speed: 1 },
  c2: { emotion: 'calm', speed: 0.95 },
}

/** 个别台词的情绪覆盖，键是「镜号:台词序号」。来自 D5，本天不改。 */
export const LINE_EMOTION: Record<string, Emotion> = {
  's02:0': 'surprised',
  's03:1': 'angry',
}

export const SHOTS: Shot[] = [
  {
    id: 's01',
    sceneId: 'sc1',
    shotSize: 'wide',
    durationSec: 6,
    characters: ['c1'],
    visual: '雨夜居民楼下，男主蹲在电动车旁',
    camera: '缓慢推近',
    dialogue: [{ characterId: 'c1', text: '这手机怎么自己亮了' }],
  },
  {
    id: 's02',
    sceneId: 'sc1',
    shotSize: 'close',
    durationSec: 3,
    characters: ['c1'],
    visual: '手机屏幕特写，显示五分钟后的新闻推送',
    camera: '固定机位',
    // 两句台词塞进 3 秒，这一镜会被 D5 顶长——留着当教学现场。
    dialogue: [
      { characterId: 'c1', text: '五分钟后的新闻，现在就推过来了' },
      { characterId: 'c1', text: '这不可能，一定是哪里出错了' },
    ],
  },
  {
    id: 's03',
    sceneId: 'sc2',
    shotSize: 'medium',
    durationSec: 8,
    characters: ['c1', 'c2'],
    visual: '便利店门口，女主拦下正要离开的男主',
    camera: '横移跟拍',
    dialogue: [
      { characterId: 'c2', text: '那部手机，不是你的' },
      { characterId: 'c1', text: '你是谁，凭什么拦我' },
    ],
  },
]
