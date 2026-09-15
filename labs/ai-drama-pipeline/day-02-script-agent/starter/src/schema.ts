// 手写 schema 校验。不引 zod 这类库，是为了让你看清「校验」到底在做什么：
// 逐字段判类型、判枚举、判范围，再判引用完整性（分镜里的角色与场景必须真的存在）。
// 校验失败不是抛异常，而是返回一串带路径的问题——因为这串问题要原样喂回给模型让它修。

import type { Character, Scene, Shot, ShotSize } from './providers/index.js'
import { VOICE_IDS } from './voices.js'

export type World = {
  title: string
  logline: string
  tone: string
  setting: string
  rules: string[]
}

export type Episode = {
  episode: number
  title: string
  scenes: Scene[]
  shots: Shot[]
}

export type Issue = { path: string; message: string }

const SHOT_SIZES: ShotSize[] = ['wide', 'medium', 'close']
/**
 * 音色必须在白名单里。实测模型会编出 male_young_01 这种不存在的 id，
 * 那样的稿子到 D5 真正合成时才会炸——所以在这里就拦下，并把候选列进报错信息，
 * 让写手带着「有哪些可选」重来一次，而不是只知道「你错了」。
 */
function voice(v: unknown, path: string, out: Issue[]): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (VOICE_IDS.includes(s)) return s
  out.push({
    path,
    message: `音色 ${JSON.stringify(v)} 不在白名单里，只能用：${VOICE_IDS.join('、')}`,
  })
  return ''
}

/**
 * 真实模型不会完全照着格式说明走。2026-09-07 用真 key 实测：即使提示词写了「id 形如 s01」，
 * MiniMax-M3 也会把镜号返回成数字 1、2、3。离线模拟器是按规范造数据的，所以这个问题
 * 只有接上真模型才会暴露——这也是「离线跑通不等于真跑通」的一个具体例子。
 *
 * 所以校验之前先做一层归一化，宽进严出。这一层只做**无损且无歧义**的转换：
 * 整数或纯数字字符串补成带前缀的编号，其他一切原样交给校验去判。
 * 不要在这里做「猜意图」式的修补——那会把模型的错悄悄藏起来，让评审循环失去意义。
 */
function coerceId(v: unknown, prefix: string): unknown {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
    return `${prefix}${String(v).padStart(2, '0')}`
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) return `${prefix}${v.padStart(2, '0')}`
  return v
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function str(v: unknown, path: string, out: Issue[], min = 1): string {
  if (typeof v !== 'string' || v.trim().length < min) {
    out.push({ path, message: `应为长度至少 ${min} 的字符串，实际是 ${JSON.stringify(v)}` })
    return ''
  }
  return v
}

function num(v: unknown, path: string, out: Issue[], min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    out.push({ path, message: `应为 ${min} 到 ${max} 之间的数字，实际是 ${JSON.stringify(v)}` })
    return min
  }
  return v
}

function list(v: unknown, path: string, out: Issue[], min: number): unknown[] {
  if (!Array.isArray(v) || v.length < min) {
    out.push({ path, message: `应为至少 ${min} 项的数组` })
    return []
  }
  return v
}

export function parseWorld(v: unknown, out: Issue[]): World {
  const o = isObj(v) ? v : {}
  if (!isObj(v)) out.push({ path: 'world', message: '应为对象' })
  return {
    title: str(o.title, 'world.title', out, 2),
    logline: str(o.logline, 'world.logline', out, 8),
    tone: str(o.tone, 'world.tone', out, 2),
    setting: str(o.setting, 'world.setting', out, 4),
    rules: list(o.rules, 'world.rules', out, 1).map((r, i) => str(r, `world.rules[${i}]`, out, 2)),
  }
}

export function parseCharacters(v: unknown, out: Issue[]): Character[] {
  return list(v, 'characters', out, 2).map((raw, i) => {
    const o = isObj(raw) ? raw : {}
    if (!isObj(raw)) out.push({ path: `characters[${i}]`, message: '应为对象' })
    return {
      id: str(coerceId(o.id, 'c'), `characters[${i}].id`, out, 2),
      name: str(o.name, `characters[${i}].name`, out, 1),
      appearance: str(o.appearance, `characters[${i}].appearance`, out, 6),
      personality: str(o.personality, `characters[${i}].personality`, out, 2),
      voiceId: voice(o.voiceId, `characters[${i}].voiceId`, out),
    }
  })
}

export function parseEpisode(v: unknown, characters: Character[], out: Issue[]): Episode {
  const o = isObj(v) ? v : {}
  if (!isObj(v)) out.push({ path: 'episode', message: '应为对象' })

  const scenes: Scene[] = list(o.scenes, 'episode.scenes', out, 1).map((raw, i) => {
    const s = isObj(raw) ? raw : {}
    return {
      id: str(coerceId(s.id, 'sc'), `scenes[${i}].id`, out, 2),
      name: str(s.name, `scenes[${i}].name`, out, 1),
      description: str(s.description, `scenes[${i}].description`, out, 6),
    }
  })

  const charIds = new Set(characters.map((c) => c.id))
  const sceneIds = new Set(scenes.map((s) => s.id))
  const seen = new Set<string>()

  const shots: Shot[] = list(o.shots, 'episode.shots', out, 3).map((raw, i) => {
    const s = isObj(raw) ? raw : {}
    const p = `shots[${i}]`
    // 练习 4：补上三处「引用完整性」检查——判类型只能挡住写错格式，挡不住写错对象。
    //   (1) 镜号 id 在本集内不能重复（用上面的 seen 集合）；
    //   (2) sceneId 必须出现在 sceneIds 里；
    //   (3) 下面 dialogue 与 characters 里的角色 id 必须出现在 charIds 里。
    //   自测：用 INJECT=badref MOCK=1 pnpm start 跑一遍。离线写手会故意产出一份
    //        镜号重复、场景 id 写成 sc9 的坏稿；补完之后应当看到
    //        「schema 不过 2 处，带着问题重来一次」，补完之前它会一路放行进 episode-1.json。
    const id = str(coerceId(s.id, 's'), `${p}.id`, out, 2)
    seen.add(id)

    const sceneId = str(coerceId(s.sceneId, 'sc'), `${p}.sceneId`, out, 2)
    void sceneIds

    const shotSize = s.shotSize
    if (typeof shotSize !== 'string' || !SHOT_SIZES.includes(shotSize as ShotSize)) {
      out.push({ path: `${p}.shotSize`, message: `景别只能是 ${SHOT_SIZES.join(' / ')}` })
    }

    // 空镜头是合法的电影语言：雨夜街景、手机屏幕特写都可以一个人都没有。
    // 这里允许 characters 为空数组；台词里引用的角色仍然会被逐个校验。
    const chars = list(s.characters, `${p}.characters`, out, 0).map((c, j) =>
      str(c, `${p}.characters[${j}]`, out, 2)
    )
    void charIds // 练习 4 的第 (3) 小问：chars 与下面的 cid 都要拿它查一遍

    const dialogue = (Array.isArray(s.dialogue) ? s.dialogue : []).map((raw2, j) => {
      const d = isObj(raw2) ? raw2 : {}
      const cid = str(coerceId(d.characterId, 'c'), `${p}.dialogue[${j}].characterId`, out, 2)
      return { characterId: cid, text: str(d.text, `${p}.dialogue[${j}].text`, out, 2) }
    })

    return {
      id,
      sceneId,
      shotSize: (SHOT_SIZES.includes(shotSize as ShotSize) ? shotSize : 'medium') as ShotSize,
      durationSec: num(s.durationSec, `${p}.durationSec`, out, 1, 60),
      characters: chars,
      visual: str(s.visual, `${p}.visual`, out, 6),
      camera: typeof s.camera === 'string' ? s.camera : '',
      dialogue,
    }
  })

  return {
    episode: num(o.episode, 'episode.episode', out, 1, 999),
    title: str(o.title, 'episode.title', out, 2),
    scenes,
    shots,
  }
}

/** 从模型回复里抠出第一段 JSON：模型经常在 JSON 前后加寒暄或者 ```json 围栏。 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start < 0) throw new Error('模型回复里找不到 JSON')
  const open = body[start]
  const close = open === '{' ? '}' : ']'
  const end = body.lastIndexOf(close)
  if (end <= start) throw new Error('模型回复里的 JSON 没有闭合')
  return JSON.parse(body.slice(start, end + 1))
}
