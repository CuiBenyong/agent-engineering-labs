/**
 * 触发判定：这一句话该让哪几张手艺卡上桌。本天新增。
 *
 * 三类条件，按可信度从高到低：
 *
 *   显式点名  用户自己说了 /skill release-notes —— 100 分，没有任何歧义
 *   路径命中  这句话里出现了技能声明的路径 —— 10 分／条，很难误报
 *   关键词    这句话里出现了技能声明的触发词 —— 3 分／条，最容易误报
 *
 * **两类误判的代价完全不对称，这是今天最值得记住的一条。**
 * 过度触发的代价是花掉一点上下文，而且看得见——注入报账里会多出一行，
 * 你当场就知道它上桌了。漏触发的代价是模型按自己的通用知识回答，
 * 答得像模像样，而**没有任何东西提示你有一份约定没被读到**。
 * 所以判定的默认姿态应该是「宁可多上一张，不要少上一张」，
 * 真正的刹车放在预算那一层，而不是放在判定这一层。
 *
 * 英文触发词按**词边界**匹配，中文按子串——中文没有空格分词，词边界无从谈起；
 * 而英文不加词边界的话，一个 test 会被 latest、contest 命中，那是最典型的误报。
 */
import type { SkillMeta } from './scan.js'

export interface Hit {
  skill: SkillMeta
  score: number
  /** 为什么命中。要打给用户看，所以写成人话 */
  reasons: string[]
}

export interface MatchInput {
  /** 用户这一句话（含他打的 @ 引用原文） */
  text: string
  /** 用户显式点名的技能 id（/skill 命令攒下来的） */
  pinned?: string[]
}

const EXPLICIT_SCORE = 100
const PATH_SCORE = 10
const TRIGGER_SCORE = 3

export function matchSkills(skills: SkillMeta[], input: MatchInput): Hit[] {
  const pinned = new Set(input.pinned ?? [])
  const hits: Hit[] = []

  for (const skill of skills) {
    let score = 0
    const reasons: string[] = []

    if (pinned.has(skill.id)) {
      score += EXPLICIT_SCORE
      reasons.push('用户用 /skill 点名了它')
    }

    // TODO(4)：路径这一类条件还没实现——现在只要触发词命中就算数，
    // 一个明明写了 paths 的技能，在「看看 src/calc.js」这句话里一分都拿不到。
    // 补上：过滤出 skill.paths 里出现在 input.text 中的那几条，每条加 PATH_SCORE 分，
    // 并往 reasons 里推一句人话（说清是哪几个路径命中的）。
    // 命中原因不是装饰：漏触发时用户只能靠这几行判断是词写窄了还是路径写错了。

    const words = skill.triggers.filter((word) => hasWord(input.text, word))
    if (words.length > 0) {
      score += TRIGGER_SCORE * words.length
      reasons.push(`触发词命中 ${words.join('、')}`)
    }

    // priority 只用来打破平局，不参与「有没有命中」的判断。
    // 让它参与的话，一个 priority 很高的技能会在一句完全不相干的话里上桌
    if (score > 0) hits.push({ skill, score: score + skill.priority / 100, reasons })
  }

  return hits.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
}

/**
 * 这句话里有没有这个触发词。
 *
 * 纯 ASCII 的词按词边界匹配，含中日韩字符的按子串。分界写在这里而不是让作者
 * 自己在 SKILL.md 里选，是因为**作者选不对**：他写触发词的时候脑子里想的是
 * 「我这个技能是干嘛的」，不是「这个词会不会在别的句子里出现」。
 */
export function hasWord(text: string, word: string): boolean {
  const target = word.trim()
  if (target === '') return false
  const haystack = text.toLowerCase()
  const needle = target.toLowerCase()
  // TODO(4)（第二半）：现在中英文一律按子串匹配，于是触发词 test 会被
  // latest、contest 命中——这是误报最主要的来源。
  // 改成：含非 ASCII 字符的词仍按子串（中文没有空格分词，词边界无从谈起），
  // 纯 ASCII 的词按词边界匹配（两侧不是字母数字）。
  // 提示：先把正则元字符转义，再拼 (^|[^a-z0-9]) ... ($|[^a-z0-9])。
  return haystack.includes(needle)
}

/** 把命中情况写成给用户看的几行。没有命中也要说，否则用户不知道判定跑过了 */
export function formatHits(hits: Hit[]): string[] {
  if (hits.length === 0) return ['（技能：这一句没有命中任何技能，阶段二注入 0 字符）']
  return hits.map(
    (hit) => `（技能命中 ${hit.skill.id}（${hit.score.toFixed(2)} 分）：${hit.reasons.join('；')}）`
  )
}
