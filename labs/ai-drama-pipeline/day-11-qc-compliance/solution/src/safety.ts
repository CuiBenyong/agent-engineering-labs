// D11 的第二块：内容安全的两道关。
// 前置那道拦的是「你自己要发出去的提示词」，后置那道拦的是「厂商给你的成片」。
// 两道都要，因为它们防的是两件事：前置省钱又免封号，后置才是真正对观众负责的那道。

export type SafetyHit = { rule: string; matched: string; suggestion: string }

/**
 * 演示用的规则表。真实项目里这层通常是「本地词表 + 厂商的审核接口 + 人工抽查」三层，
 * 这里只写最外面那层，重点是让你看到「拦下之后要给替代方案」，而不是直接报错了事。
 */
const RULES: { rule: string; patterns: RegExp[]; suggestion: string }[] = [
  {
    rule: '不得生成真实人物形象',
    patterns: [
      /真人明星/,
      /本人出镜/,
      /和.{0,4}明星.{0,4}一模一样/,
      /真实存在的.{0,4}(演员|主播|名人)/,
    ],
    suggestion: '改成原创人物的外貌描述，不指向任何真实存在的人',
  },
  {
    rule: '不得使用他人商标与品牌标识',
    patterns: [/品牌logo/i, /商标/],
    suggestion: '道具用无标识的通用款',
  },
  {
    rule: '不得出现血腥暴力细节',
    patterns: [/血肉模糊/, /断肢/],
    suggestion: '改成不展示细节的侧写或留白',
  },
]

export function checkPrompt(text: string): SafetyHit[] {
  const hits: SafetyHit[] = []
  for (const r of RULES) {
    for (const p of r.patterns) {
      const m = p.exec(text)
      if (m) {
        hits.push({ rule: r.rule, matched: m[0], suggestion: r.suggestion })
        break
      }
    }
  }
  return hits
}

/** 拦下之后要能继续跑：把命中的片段换成安全表述，而不是让整条流水线停在这里。 */
export function sanitize(text: string, hits: SafetyHit[]): string {
  let out = text
  for (const h of hits) out = out.replace(h.matched, '［已按内容安全规则改写］')
  return out
}

/**
 * 后置检查：成片出来之后再过一遍。
 * 它比前置那道更重要——提示词干净不代表生成结果干净，模型会自己加戏。
 */
export function checkOutput(input: {
  subtitles: string[]
  hasImplicitLabel: boolean
  hasExplicitLabel: boolean
}): string[] {
  const problems: string[] = []
  for (const s of input.subtitles) {
    const hits = checkPrompt(s)
    if (hits.length > 0) problems.push(`字幕命中「${hits[0].rule}」：${s}`)
  }
  if (!input.hasImplicitLabel) problems.push('成片文件里没有隐式标识')
  if (!input.hasExplicitLabel) problems.push('成片没有可被用户感知的显式标识')
  return problems
}
