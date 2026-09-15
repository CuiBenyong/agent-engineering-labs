// 标题与封面文案：批量出候选 → 打分 → 挑前三。
//
// 这一节的关键判断是「挑选而不是生成」：让模型一次给出最终答案，质量下限完全不可控；
// 让它按不同角度各给一版，再用一个确定性的打分函数收敛，下限就由打分函数兜住了。

import type { TextProvider } from './providers/index.js'
import type { Shot } from './providers/index.js'

export type Angle = {
  id: string
  name: string
  instruction: string
  build: (ctx: TitleContext) => string
}

export type TitleContext = {
  protagonist: string
  rival: string
  hook: string
  twist: string
  keyword: string
}

export const ANGLES: Angle[] = [
  {
    id: 'a1',
    name: '悬念式',
    instruction: '写一个让人想知道后面发生了什么的短剧标题',
    build: (c) => `${c.hook}，${c.protagonist}只剩五分钟`,
  },
  {
    id: 'a2',
    name: '反差式',
    instruction: '写一个前后反差强烈的短剧标题',
    build: (c) => `${c.protagonist}以为捡到宝，结果${c.twist}`,
  },
  {
    id: 'a3',
    name: '身份式',
    instruction: '写一个点明人物关系的短剧标题',
    build: (c) => `${c.rival}说那部${c.keyword}不是他的`,
  },
  {
    id: 'a4',
    name: '数字式',
    instruction: '写一个带具体数字的短剧标题',
    build: (c) => `提前5分钟知道结局的${c.keyword}`,
  },
  {
    id: 'a5',
    name: '陈述式',
    instruction: '写一个平铺直叙、信息密度高的短剧标题',
    build: (c) => `${c.protagonist}捡到一部会预知未来的${c.keyword}`,
  },
]

export type Candidate = {
  id: string
  angle: string
  title: string
  /** 封面上的那行大字，通常比标题更短更狠 */
  coverCopy: string
  /** 封面文案是模型给的还是回落到本地模板 */
  coverFromModel: boolean
  score: number
  reasons: string[]
}

/** 明显不能上封面的词：夸大与承诺。命中直接扣重分，别指望人工去挑。 */
const BANNED = ['最强', '第一', '必看', '震惊', '国家级', '包赚', '免费领']

export function scoreTitle(
  title: string,
  ctx: TitleContext,
  others: string[]
): { score: number; reasons: string[] } {
  // 练习 2：写出打分函数，让「挑选」真的能收敛。
  //   建议的加减分项：长度落在 8–18 字 +3、否则 -2；有疑问或转折语气 +2；
  //   点到了 ctx.protagonist 或 ctx.rival +1；带阿拉伯数字 +1；
  //   命中 BANNED 里的夸大用语 -5；与 others 里某条重合度超过 0.7（用 overlap）-2。
  //   每一项都要往 reasons 里写一句话——分数不解释，等于没有下限。
  // 现在全部 0 分：五条候选并列，「前三」只是按 id 排出来的，挑选完全没有发生。
  void title
  void ctx
  void others
  void BANNED
  void overlap
  return { score: 0, reasons: ['（练习 2 未完成）打分函数还没写'] }
}

function overlap(a: string, b: string): number {
  const sa = new Set([...a])
  const sb = new Set([...b])
  let same = 0
  for (const ch of sa) if (sb.has(ch)) same += 1
  return same / Math.max(sa.size, sb.size)
}

/** 模型给的那行字能不能直接上封面。挡不住就回落到本地模板，别把调试信息印在封面上。 */
export function usableCoverCopy(raw: string): string | null {
  // 练习 3：把模型给的那行字挡一道。
  //   取第一行非空文本；长度不在 4–14 字之间返回 null；
  //   含中括号 / 大括号 / 尖括号这类调试符号返回 null；命中 BANNED 返回 null。
  //   返回 null 时调用方会回落到本地模板——这就是「模型不可控，兜底可控」。
  // 现在原样放行：离线模式下模型回的是带【离线模拟】的占位文本，会被直接印上封面。
  return (
    raw
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? null
  )
}

export function buildContext(shots: Shot[], names: Record<string, string>): TitleContext {
  const first = shots[0]
  const last = shots[shots.length - 1]
  return {
    protagonist: names[first?.characters[0] ?? ''] ?? '主角',
    rival: names[last?.dialogue[0]?.characterId ?? ''] ?? '对手',
    hook: first?.dialogue[0]?.text.replace(/[。？！]/g, '') ?? '一个意外',
    twist: last?.dialogue[0]?.text.replace(/[。？！]/g, '') ?? '事情不对劲',
    keyword: '手机',
  }
}

export async function generateCandidates(
  text: TextProvider,
  ctx: TitleContext
): Promise<Candidate[]> {
  const titles = ANGLES.map((a) => a.build(ctx))
  const out: Candidate[] = []
  for (const [i, angle] of ANGLES.entries()) {
    const title = titles[i] ?? ''
    // 每个角度各调一次模型要一行封面大字。离线模式下模型回的是占位文本，
    // 会被 usableCoverCopy 挡下来并回落——挡不挡得住，本身就是这一节要教的东西。
    const raw = await text.complete({
      system: '你是短剧发行编辑，只输出一行不超过 14 个字的封面大字，不要解释。',
      user: `${angle.instruction}。剧情：${ctx.protagonist}捡到一部能预知未来的${ctx.keyword}，${ctx.rival}来讨要。标题是「${title}」。`,
    })
    const fromModel = usableCoverCopy(raw.text)
    out.push({
      id: `${angle.id}`,
      angle: angle.name,
      title,
      coverCopy: fromModel ?? title.slice(0, 12),
      coverFromModel: fromModel !== null,
      score: 0,
      reasons: [],
    })
  }
  for (const c of out) {
    const r = scoreTitle(c.title, ctx, titles)
    c.score = r.score
    c.reasons = r.reasons
  }
  // 同分时按 id 定序，保证两次运行挑出来的前三完全一致。
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
