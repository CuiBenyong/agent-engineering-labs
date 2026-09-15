// MOCK=1 时替换掉文本 provider 的那一个网络出口。
// 它不是「返回一段常量」：世界观、人物、分镜全部由输入的一句话推导，
// 评审的软分也由真实的分镜内容算出来——所以换一句话，产出和分数都会跟着变。
// 硬伤则由 review.ts 里的代码在两种模式下同样地跑一遍。

import type { TextProvider, TextResult } from './providers/index.js'
import type { HardCode } from './review.js'
import type { Episode } from './schema.js'
import { FEMALE_VOICES, MALE_VOICES } from './voices.js'

function pickVoice(idea: string, table: [string, string][], fallback: string): string {
  return table.find(([k]) => idea.includes(k))?.[1] ?? fallback
}

function hash(s: string): number {
  let h = 2166136261
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return Math.abs(h)
}

/** 从一句话里挑出前两个两字以上的名词性片段当地点，凑不够就用默认场景。 */
function sceneNames(idea: string): string[] {
  const found = (idea.match(/[一-龥]{2,4}(?=里|上|下|边|口|外|中)/g) ?? []).slice(0, 2)
  return [...found, '深夜街边', '出租屋', '天台'].slice(0, 3)
}

export class OfflineScriptText implements TextProvider {
  readonly name = 'mock'
  readonly model = 'offline-script'
  /** 已经修好的硬伤类别。模拟「模型被指出问题后逐轮改稿」，所以分数会一轮一轮涨。 */
  private readonly fixed = new Set<HardCode>()

  async complete(input: { system?: string; user: string }): Promise<TextResult> {
    const text = this.render(input.system ?? '', input.user)
    return { text, promptTokens: input.user.length, completionTokens: text.length }
  }

  private render(system: string, user: string): string {
    if (system.includes('评审')) return this.review(user)
    const idea = /一句话：(.*)/.exec(user)?.[1]?.trim() ?? '无题'
    if (user.includes('世界观档案 JSON')) return json(this.world(idea))
    if (user.includes('人物卡 JSON 数组')) return json(this.characters(idea))
    if (user.includes('分镜 JSON')) return json(this.episode(idea, user))
    return json({ note: '离线实现不认识这个请求' })
  }

  private world(idea: string) {
    return {
      title: `${idea.slice(0, 6)}的十四天`,
      logline: `${idea}，从此他每一步都被人盯着。`,
      tone: '悬疑 加 都市',
      setting: `故事发生在一座常年下雨的南方城市，${sceneNames(idea)[0]}是所有转折的起点。`,
      rules: [`${idea}这件事只有主角自己知道`, '每一集结尾必须留一个没答完的问题'],
    }
  }

  private characters(idea: string) {
    return [
      {
        id: 'c1',
        name: '林野',
        appearance: '二十五岁男性，短发，蓝色工服，左手腕有旧伤',
        personality: '嘴硬心软',
        voiceId: pickVoice(idea, MALE_VOICES, 'junlang_nanyou'),
      },
      {
        id: 'c2',
        name: '苏晓',
        appearance: '二十三岁女性，长发，米色针织衫，总背着相机',
        personality: '冷静敏锐',
        voiceId: pickVoice(idea, FEMALE_VOICES, 'tianxin_xiaoling'),
      },
    ]
  }

  private episode(idea: string, user: string): Episode {
    // 从评审意见里挑一条还没修的硬伤修掉——一轮修一类，收敛过程才看得见。
    const codes = [...user.matchAll(/\[(camera|duration|dialogue|coverage|pacing)\]/g)].map(
      (m) => m[1] as HardCode
    )
    const next = codes.find((c) => !this.fixed.has(c))
    if (next) this.fixed.add(next)

    // INJECT=badref：故意产出一份引用了不存在场景、且镜号重复的坏稿，
    // 只注入第一轮的第一次，校验把问题喂回来之后就不再注入。
    const inject =
      process.env.INJECT === 'badref' &&
      !user.includes('评审意见') &&
      !user.includes('不存在的场景')

    const scenes = sceneNames(idea).map((name, i) => ({
      id: `sc${i + 1}`,
      name,
      description: `${name}，雨后湿漉漉的地面反着招牌的光，${idea}的痕迹留在这里。`,
    }))
    const count = 8 + (hash(idea) % 3)
    const shots = Array.from({ length: count }, (_, i) => {
      const scene = scenes[i % scenes.length]
      const who = i % 3 === 2 ? 'c2' : 'c1'
      const longLine = `${idea}这件事我不能告诉任何人否则我们两个都会被牵连进去`
      return {
        id: `s${String(inject && i === 1 ? 1 : i + 1).padStart(2, '0')}`,
        sceneId: inject && i === 2 ? 'sc9' : scene.id,
        shotSize: (i === 0
          ? 'close'
          : i % 3 === 1
            ? 'wide'
            : 'medium') as Episode['shots'][number]['shotSize'],
        // 未修 duration 时第 3 镜故意超长，触发 [duration]
        durationSec: !this.fixed.has('duration') && i === 2 ? 12 : 6,
        characters: i % 4 === 3 ? ['c1', 'c2'] : [who],
        visual: `${scene.name}，${idea}的第 ${i + 1} 个瞬间，主角的表情被招牌的光照亮`,
        // 未修 camera 时第 2、4、6 镜留空，触发三条 [camera]
        camera:
          !this.fixed.has('camera') && [1, 3, 5].includes(i)
            ? ''
            : i % 2 === 0
              ? '缓慢推近'
              : '横移跟拍',
        dialogue: [
          {
            characterId: who,
            // 未修 dialogue 时第 5 镜给一句超长台词，触发 [dialogue]
            text:
              !this.fixed.has('dialogue') && i === 4
                ? longLine
                : `第 ${i + 1} 镜，${who === 'c1' ? '别过来' : '你骗不了我'}`,
          },
        ],
      }
    })
    return { episode: 1, title: `${idea.slice(0, 8)}（第一集）`, scenes, shots }
  }

  /** 软分：只看程序判不了的两件事——开场是不是特写、有台词的镜头占比。 */
  private review(user: string): string {
    const ep = JSON.parse(/```json\s*([\s\S]*?)```/.exec(user)?.[1] ?? '{}') as Partial<Episode>
    const shots = ep.shots ?? []
    const hookish = shots[0]?.shotSize === 'close'
    const covered = shots.filter((s) => s.dialogue.length > 0).length / Math.max(1, shots.length)
    const score = 80 + (hookish ? 5 : 0) + (covered >= 0.8 ? 5 : 0)
    const issues = [
      hookish ? '开场是特写，钩子成立' : '开场是大景，前三秒抓不住人',
      covered >= 0.8 ? '台词覆盖足够，人物动机能读出来' : '半数镜头没有台词，动机全靠画面猜',
    ]
    return json({ score, issues })
  }
}

const json = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```'

/** 唯一的选择点：离线换掉文本 provider，其余业务代码一行都不用改。 */
export function pickTextProvider(real: TextProvider): TextProvider {
  return process.env.MOCK === '1' ? new OfflineScriptText() : real
}
