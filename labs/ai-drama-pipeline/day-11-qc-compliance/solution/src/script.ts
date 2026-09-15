// 样例剧本与 SRT 生成。质检与合规逻辑不关心剧本内容，放在这里让 index.ts 只剩编排。

import type { Character, Shot } from './providers/index.js'

export const dialogueOf = (s: Shot) => s.dialogue[0]?.text ?? ''
export const voiceIdOf = (s: Shot) =>
  CAST.find((c) => c.id === s.dialogue[0]?.characterId)?.voiceId ?? 'male-qn-qingse'

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

export function draftShots(inject: string): Shot[] {
  const low = inject === 'lowscore'
  return [
    // 第一镜的画面描述里故意留了一条会被前置检查拦下的要求。
    {
      id: 's01',
      sceneId: 'sc1',
      shotSize: 'wide',
      durationSec: 2,
      characters: ['c1'],
      visual: '雨夜居民楼下，男主蹲在电动车旁，长得和真人明星一模一样',
      camera: '缓慢推近',
      dialogue: [{ characterId: 'c1', text: '这手机怎么又亮了' }],
    },
    // 注入 lowscore 时，第二镜的台词长到一屏放不下，会被字幕检查打回；不注入时它是正常长度。
    {
      id: 's02',
      sceneId: 'sc1',
      shotSize: 'close',
      durationSec: low ? 4 : 2,
      characters: ['c1'],
      visual: '手机屏幕特写，显示着五分钟后的新闻推送',
      camera: '固定机位',
      dialogue: [
        {
          characterId: 'c1',
          text: low
            ? '五分钟后的新闻怎么会现在就出现在我这台破手机的屏幕上啊这也太离谱了'
            : '五分钟后？这不可能',
        },
      ],
    },
    // 注入 lowscore 时，第三镜是多人多手的高风险构图，评审官会一直判它崩坏——重做换种子也救不回来。
    {
      id: 's03',
      sceneId: 'sc2',
      shotSize: 'medium',
      durationSec: 2,
      characters: ['c2'],
      visual: low
        ? '便利店门口，两人同时伸手去抢那部手机，六只手挤在画面里'
        : '便利店门口，女主把伞举到男主头顶',
      camera: '横移跟拍',
      dialogue: [{ characterId: 'c2', text: '那部手机不是你的' }],
    },
  ]
}

export function buildSrt(shots: Shot[]): string {
  const stamp = (ms: number) => {
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
  }
  let cursor = 0
  return shots
    .map((s, i) => {
      const start = cursor
      cursor += s.durationSec * 1000
      return `${i + 1}\n${stamp(start)} --> ${stamp(cursor)}\n${dialogueOf(s)}\n`
    })
    .join('\n')
}
