import { getEncoding } from 'js-tiktoken'
import type { Candidate } from './retrieve.js'
import { tokenize } from './retrieve.js'

/**
 * 生成侧：按 token 预算装上下文、带块编号引用、事后校验引用、拒答分类。
 *
 * 机制全部来自 D6（引用是闭集、可信度来自代码回查而不是模型自觉）与 D8（预算口径）。
 * 本天不重讲原理，只做两件事：
 *
 * 1. 把 D6 的引用校验结果**接进评估面板**——「引用错位」从此是一个有数字的失败模式，
 *    而不是一句抱怨；
 * 2. 把拒答的三种原因**分开记账**。混成一句「抱歉查不到」，
 *    你就再也分不清系统是没检索到、还是检索到了但材料不支持。
 */

/** 上下文预算逐字沿用 D4/D8/D9/D12 的 600 token。改了就跟前面各天的数字不可比 */
export const CONTEXT_BUDGET = Number(process.env.CONTEXT_BUDGET ?? 600)
/** 引用的实质重合度阈值，沿用 D6 */
const MIN_OVERLAP = 0.3

const ENC = getEncoding('cl100k_base')
export const countTokens = (text: string): number => ENC.encode(text).length

export interface Block {
  /** 本次请求内的呈现序号，模型只能引用它（D6：可验证性来自闭集） */
  n: number
  candidate: Candidate
}

/** 按 token 预算往里装，装满就停。这就是「进没进上下文」这句话的确切含义 */
export function packContext(candidates: Candidate[]): { blocks: Block[]; tokens: number } {
  const blocks: Block[] = []
  let tokens = 0
  for (const candidate of candidates) {
    const cost = countTokens(candidate.chunk.text)
    if (tokens + cost > CONTEXT_BUDGET) break
    tokens += cost
    blocks.push({ n: blocks.length + 1, candidate })
  }
  return { blocks, tokens }
}

/** 在多数块里都出现的词元没有区分度，算重合度前要剔掉（D6：否则随便引哪一块都能及格） */
function commonTerms(blocks: Block[]): Set<string> {
  const df = new Map<string, number>()
  for (const b of blocks) {
    for (const t of new Set(tokenize(b.candidate.chunk.text))) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const limit = Math.max(2, Math.ceil(blocks.length * 0.6))
  return new Set([...df].filter(([, n]) => n >= limit).map(([t]) => t))
}

export function overlapRatio(sentence: string, blockText: string, common: Set<string>): number {
  const terms = [...new Set(tokenize(sentence))].filter((t) => !common.has(t))
  if (terms.length === 0) return 0
  const inBlock = new Set(tokenize(blockText))
  return terms.filter((t) => inBlock.has(t)).length / terms.length
}

export type RefusalReason =
  /** 一条候选都没过门槛：库里根本没有够得着的材料。生成之前就能判 */
  | 'no-admitted-candidate'
  /** 材料看着相关，但没有一句结论站得住（引用校验零通过）。只能生成之后判 */
  | 'no-verifiable-claim'
  /** 这个租户的订阅范围里没有能回答它的文档。多租户特有的第三种拒答 */
  | 'out-of-tenant-scope'

export interface Answered {
  status: 'answered' | 'refused'
  reason?: RefusalReason
  text: string
  blocks: Block[]
  contextTokens: number
  /** 通过校验的引用块编号 */
  verified: number[]
  /** 被拦下的引用及原因（D6 的两道闸） */
  rejected: string[]
  outTokens: number
}

const REFUSAL_TEXT: Record<RefusalReason, string> = {
  'no-admitted-candidate':
    '资料中没有找到能支撑回答的内容，换个说法再问，或确认这份资料是否已经入库。',
  'no-verifiable-claim': '找到了相关文档，但里面没有能直接回答这个问题的内容。',
  'out-of-tenant-scope': '这个工作区没有导入能回答该问题的文档，请联系管理员确认订阅范围。',
}

/**
 * 生成一段带引用的回答。
 *
 * `MOCK=1` 下不调模型：从每一块里挑出与问题字面重合度最高的那一句，配上块编号。
 * 这样离线也能看到真实现象——**引用校验会真的拦下重合度不够的那几句**，
 * 而不是让人相信一段假装成功的日志。真模型分支的提示词结构与 D6 一致。
 */
export async function answer(
  question: string,
  candidates: Candidate[],
  outOfScope: boolean
): Promise<Answered> {
  const admitted = candidates.filter((c) => c.admitted)
  const { blocks, tokens } = packContext(admitted)

  const refuse = (reason: RefusalReason): Answered => ({
    status: 'refused',
    reason,
    text: REFUSAL_TEXT[reason],
    blocks,
    contextTokens: tokens,
    verified: [],
    rejected: [],
    outTokens: countTokens(REFUSAL_TEXT[reason]),
  })

  // 顺序有讲究：租户范围这一条最先判，因为它给用户的下一步动作完全不同
  // （「联系管理员开订阅」而不是「换个说法再问」）
  if (outOfScope && blocks.length === 0) return refuse('out-of-tenant-scope')
  if (blocks.length === 0) return refuse('no-admitted-candidate')

  const common = commonTerms(blocks)
  const sentences: Array<{ text: string; n: number }> = []
  for (const block of blocks.slice(0, 3)) {
    const best = block.candidate.chunk.text
      .split(/[。；\n]/u)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8)
      .map((s) => ({ s, r: overlapRatio(question, s, common) }))
      .sort((a, b) => b.r - a.r)[0]
    if (best) sentences.push({ text: best.s, n: block.n })
  }

  // 事后校验：编号必须在闭集里（这里天然成立），且被引块与这句话有实质重合
  const verified: number[] = []
  const rejected: string[] = []
  const kept: string[] = []
  for (const s of sentences) {
    const block = blocks.find((b) => b.n === s.n)
    if (!block) {
      rejected.push(`引用了不存在的块编号 [${s.n}]`)
      continue
    }
    const ratio = overlapRatio(s.text, block.candidate.chunk.text, common)
    if (ratio < MIN_OVERLAP) {
      rejected.push(`[${s.n}] 与这句话的实质重合度只有 ${ratio.toFixed(2)}`)
      continue
    }
    verified.push(s.n)
    kept.push(`${s.text}[${s.n}]`)
  }

  if (verified.length === 0) {
    return { ...refuse(outOfScope ? 'out-of-tenant-scope' : 'no-verifiable-claim'), rejected }
  }
  const text = `${kept.join('。')}。`
  return {
    status: 'answered',
    text,
    blocks,
    contextTokens: tokens,
    verified,
    rejected,
    outTokens: countTokens(text),
  }
}
