import type { Block, Scored } from './assemble'
import { tokenize } from './tokenize'

/**
 * 今天的核心：引用校验与拒答判定。
 *
 * 整个模块**不调用任何模型**，只做两件代码能做的事：
 * 1. 模型给的块编号是不是真的存在；
 * 2. 被引的那一块，跟这句话是不是真的有实质重合。
 * 这两件事不能交给模型自己保证——「请确保引用准确」这句提示词的可信度是零。
 */

/** 模型输出的一条结论：一句话 + 它声称的出处编号 */
export interface Claim {
  text: string
  citations: number[]
}

export type ClaimIssue = 'unknown_block' | 'weak_overlap' | 'uncited'

export interface ClaimVerdict {
  claim: Claim
  ok: boolean
  issues: ClaimIssue[]
  /** 通过校验的编号 */
  verified: number[]
  /** 每个编号的重合度，用于调阈值和排查 */
  overlap: Record<number, number>
  detail: string[]
}

export interface VerifyResult {
  verdicts: ClaimVerdict[]
  ok: boolean
  /** 至少被一条结论正确引用过的块编号，升序 */
  verifiedCitations: number[]
}

export const DEFAULT_MIN_OVERLAP = 0.3

/**
 * 实质重合度：这句话里的词元，有多大比例能在被引块里找到。
 *
 * 两个细节决定了它管不管用：
 * - **按词元去重**，否则一句话里重复出现的「的」会把分母撑大；
 * - **丢掉在多数块里都出现的词元**。「云梯」「文件」这种词到处都是，
 *   用它们算重合，随便引哪一块都能及格——这跟 BM25 用逆文档频率压常见词是同一个道理。
 */
export function overlapRatio(sentence: string, blockText: string, common: Set<string>): number {
  // 练习 2：算这句话与被引块的实质重合度。
  //   1) 用 tokenize 把句子切成词元，去重，再滤掉 common 里的高频词；
  //   2) 把被引块也切成词元放进 Set；
  //   3) 返回「命中的词元数 / 句子词元数」。
  // 现在无脑返回 1，等于只校验了编号存不存在——**编号是真的、内容对不上**的那一类编造
  // 会一路放行。自测第三项会指出这一点。
  void sentence
  void blockText
  void common
  return 1
}

/** 在多于 60% 的块里都出现的词元没有区分度，算重合时不计 */
export function commonTerms(blocks: Block[]): Set<string> {
  const df = new Map<string, number>()
  for (const block of blocks) {
    for (const term of new Set(tokenize(block.chunk.text))) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  const limit = Math.max(2, Math.ceil(blocks.length * 0.6))
  return new Set([...df.entries()].filter(([, n]) => n > limit).map(([t]) => t))
}

/**
 * 逐句校验。校验的对象是 `chunk.text` **原文**，不是放进提示词的压缩版——
 * 用户点开引用看到的是原文，校验就必须按原文来，否则「校验通过」保证不了任何事。
 */
export function verifyAnswer(
  claims: Claim[],
  blocks: Block[],
  minOverlap: number = DEFAULT_MIN_OVERLAP
): VerifyResult {
  const byNumber = new Map(blocks.map((b) => [b.n, b]))
  const common = commonTerms(blocks)
  const verifiedAll = new Set<number>()

  const verdicts = claims.map((claim) => {
    const issues: ClaimIssue[] = []
    const verified: number[] = []
    const overlap: Record<number, number> = {}
    const detail: string[] = []

    if (claim.citations.length === 0) {
      issues.push('uncited')
      detail.push('这句话没有给出任何出处')
    }

    for (const n of claim.citations) {
      const block = byNumber.get(n)
      if (!block) {
        // 第一道闸：编号根本不存在。模型编引用时最常见的形态就是编一个大一号的编号
        issues.push('unknown_block')
        detail.push(`引用了不存在的块编号 [${n}]（本次只发出了 1..${blocks.length}）`)
        continue
      }
      const ratio = overlapRatio(claim.text, block.chunk.text, common)
      overlap[n] = Number(ratio.toFixed(3))
      if (ratio < minOverlap) {
        // 第二道闸：编号存在，但这句话跟那一块说的不是一回事。
        // 这一类比编号不存在更隐蔽——编号看着是真的，点进去才发现对不上。
        issues.push('weak_overlap')
        detail.push(`[${n}] 与这句话的实质重合度只有 ${ratio.toFixed(2)}，低于阈值 ${minOverlap}`)
        continue
      }
      verified.push(n)
      verifiedAll.add(n)
    }

    return { claim, ok: issues.length === 0, issues, verified, overlap, detail }
  })

  return {
    verdicts,
    ok: verdicts.every((v) => v.ok),
    verifiedCitations: [...verifiedAll].sort((a, b) => a - b),
  }
}

/** 把校验结果整理成一段能直接塞回提示词的反馈，用于打回重生成 */
export function feedbackForRetry(result: VerifyResult): string {
  const lines = result.verdicts
    .filter((v) => !v.ok)
    .map((v) => `- 这一句有问题：「${v.claim.text}」；原因：${v.detail.join('；')}`)
  return [
    '上一版回答没有通过引用校验，请重写。问题如下：',
    ...lines,
    '重写要求：每一句结论都必须来自给定的块，编号只能用发给你的那些，句子要与被引块的内容实质重合。',
    '如果材料确实支撑不了，就直接说材料里没有，不要硬凑。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 拒答判定
// ---------------------------------------------------------------------------

export type RefusalKind = 'low_score' | 'conflict' | 'unsupported'

export interface ConflictEvidence {
  unit: string
  left: { chunkId: string; value: string; updatedAt: string; raw: string }
  right: { chunkId: string; value: string; updatedAt: string; raw: string }
}

export interface Refusal {
  kind: RefusalKind
  /** 直接返回给用户的话术。三种情况的话术必须不同，见正文 */
  message: string
  conflict?: ConflictEvidence
}

export const DEFAULT_MIN_SCORE = 6

/** 数量断言：一个数字 + 单位，加上它前面十四个字里的词元作为上下文键 */
interface Quantity {
  value: string
  unit: string
  raw: string
  keys: Set<string>
}

const UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*(MB|GB|TB|%|天|小时|分钟|秒|个|次|人|元)/gi

export function extractQuantities(text: string): Quantity[] {
  const out: Quantity[] = []
  for (const m of text.matchAll(UNIT_PATTERN)) {
    const start = Math.max(0, (m.index ?? 0) - 14)
    const context = text.slice(start, m.index ?? 0)
    out.push({
      value: m[1],
      unit: m[2].toUpperCase(),
      raw: m[0],
      keys: new Set(tokenize(context)),
    })
  }
  return out
}

/**
 * 材料冲突检测：不问模型，直接在块之间找**同一件事的不同数字**。
 *
 * 判据三条同时成立才算冲突：来自不同文档、单位相同、数值不同，
 * 而且两个数字前面的上下文至少共享两个词元——最后这条是防误报的关键，
 * 少了它，「回收站保留 30 天」和「试用期 90 天」会被判成冲突。
 *
 * 这套办法只覆盖「带单位的数字」这一类冲突，覆盖不了「政策说法相反」这种文字冲突。
 * 那一类要靠模型判断，成本和误判率都高得多；带数字的这一类恰恰是知识库里最常见、
 * 也最容易造成实际损失的一类（用户按 100 MB 压缩了半天的视频）。
 */
export function detectConflict(blocks: Block[]): ConflictEvidence | null {
  // 练习 3：两两比较块里的数量断言，判出冲突。三条判据同时成立才算：
  //   来自不同文档、单位相同、数值不同，并且两个数字前面的上下文至少共享 2 个词元。
  //   最后一条是防误报的关键，少了它「回收站保留 30 天」和「试用期 90 天」会被判成冲突。
  //   上下文键已经由 extractQuantities 算好了，在 Quantity.keys 里。
  // 现在永远返回 null，于是「单个文件最大能传多大」会拿到一个**看起来很确定的单一答案**——
  // 而语料里有两篇文档对这件事的说法并不一样。自测第五项会抓住它。
  void blocks
  void extractQuantities
  return null
}

/** 生成之前就能下的判断：分数太低，以及材料自己打架 */
export function preCheck(
  scored: Scored[],
  blocks: Block[],
  minScore: number = DEFAULT_MIN_SCORE
): Refusal | null {
  const top = scored[0]?.score ?? 0
  if (top < minScore) {
    return {
      kind: 'low_score',
      message: `知识库里没有和这个问题相关的材料（最高检索分 ${top.toFixed(2)}，低于阈值 ${minScore}）。换个说法再问一次，或者确认这份资料是不是还没有入库。`,
    }
  }

  const conflict = detectConflict(blocks)
  if (conflict) {
    const [newer, older] =
      conflict.left.updatedAt >= conflict.right.updatedAt
        ? [conflict.left, conflict.right]
        : [conflict.right, conflict.left]
    return {
      kind: 'conflict',
      message: [
        '检索到的材料对同一件事给出了不同的数字，我不替你选一个：',
        `- ${newer.raw}，来自 ${newer.chunkId}，更新于 ${newer.updatedAt}`,
        `- ${older.raw}，来自 ${older.chunkId}，更新于 ${older.updatedAt}`,
        `两份材料相差 ${diffInDays(newer.updatedAt, older.updatedAt)} 天。一般以新的为准，但请以文档负责人的确认为最终依据。`,
      ].join('\n'),
      conflict,
    }
  }

  return null
}

function diffInDays(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000)
}

/**
 * 生成之后才能下的判断：检索分很高、材料看着相关，但没有一句结论站得住。
 *
 * 这就是 D1 留下的 b09（「报销手机话费」）那个短板：满篇都是「报销」，
 * 分数阈值挡不住，材料里却根本没提话费。**分数高不等于答得了**，
 * 所以第三条线只能放在生成之后、拿校验结果来判。
 */
export function postCheck(result: VerifyResult): Refusal | null {
  if (result.verifiedCitations.length > 0) return null
  return {
    kind: 'unsupported',
    message:
      '检索到了相关的文档，但里面没有能直接回答这个问题的内容，所以我不作答。这通常意味着问题超出了这份知识库覆盖的范围，建议直接问文档负责人。',
  }
}
