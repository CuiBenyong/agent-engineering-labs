import Anthropic from '@anthropic-ai/sdk'
import type { RagConfig } from './config'
import { isMock } from './config'
import type { Candidate } from './retrieve'
import { tokenize } from './retrieve'

/**
 * 生成侧（D6）。三件事：把块排好组装成上下文、让模型按块编号标出处、
 * 在证据不足时闭嘴。第三件最容易被省掉，省掉之后系统会在没有材料时编得最欢。
 *
 * 编号口径沿用 D6：发给模型的是**本次的块序号 1、2、3**，不是 chunkId。
 * 闭集编号有两个好处——模型编不出「看起来很像真的」的编号，
 * 而且校验时一眼能判出越界；chunkId 只在返回给用户时才映射回去。
 */

export const REFUSAL = '资料中没有找到能支撑回答的内容。'

/** 一次问答里发给模型的块，n 从 1 开始 */
export interface Block {
  n: number
  chunk: Candidate['chunk']
}

export interface Citation {
  n: number
  chunkId: string
  /** 引用它的那句话，方便读者点开对照 */
  sentence: string
  /** 实质重合度，用来调阈值和排查 */
  overlap: number
}

export interface AnswerResult {
  answer: string
  refused: boolean
  citations: Citation[]
  /** 被校验拦下来的引用，每条写清是编号不存在还是重合度不够 */
  rejectedCitations: string[]
}

export function toBlocks(used: Candidate[]): Block[] {
  return used.map((c, i) => ({ n: i + 1, chunk: c.chunk }))
}

export function buildPrompt(
  question: string,
  blocks: Block[],
  cfg: RagConfig
): { system: string; user: string } {
  const system = [
    '你是云梯科技的知识库助手。只能依据下面提供的资料回答问题。',
    `资料里找不到答案时，只回复这一句：${REFUSAL}`,
    '每一条结论都必须标出它来自哪一块，用发给你的块编号（形如 1、2），格式如 [1]。不要编造编号，也不要引用没发给你的编号。',
    '如果两块资料互相矛盾，把两种说法都列出来并指出各自的更新日期，不要自己挑一个。',
  ].join('\n')

  // 组装顺序：分数高的放最前和最后都有讲究（中间位置的材料容易被忽略，见 D6）。
  // 这里保持按分数降序，并在总长度上设一个硬预算——超了就截断，不能让上下文无限膨胀。
  let budget = cfg.generation.maxContextChars
  const parts: string[] = []
  for (const b of blocks) {
    const head = b.chunk.headingPath.length ? `｜${b.chunk.headingPath.join(' > ')}` : ''
    const text = `[${b.n}]（${b.chunk.department}，更新于 ${b.chunk.updatedAt}${head}）\n${b.chunk.text}`
    if (text.length > budget) break
    budget -= text.length
    parts.push(text)
  }

  return { system, user: `资料：\n\n${parts.join('\n\n---\n\n') || '（无）'}\n\n问题：${question}` }
}

/** 从一块里挑与问题重合度最高的一句，MOCK 模式下用它拼答案 */
function bestSentence(text: string, question: string): string {
  const wanted = new Set(tokenize(question))
  const sentences = text
    .split(/[\n。！？；]/)
    .map((s) => s.replace(/^[#>\-*\s|]+/, '').trim())
    .filter((s) => s.length >= 8)
  let best = sentences[0] ?? text.slice(0, 60)
  let bestHit = -1
  for (const s of sentences) {
    const hit = tokenize(s).filter((t) => wanted.has(t)).length
    if (hit > bestHit) {
      bestHit = hit
      best = s
    }
  }
  return best
}

/** 在多于 60% 的块里都出现的词元没有区分度，算重合时不计（口径来自 D6） */
export function commonTerms(blocks: Block[]): Set<string> {
  const df = new Map<string, number>()
  for (const b of blocks) {
    for (const term of new Set(tokenize(b.chunk.text))) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const limit = Math.max(2, Math.ceil(blocks.length * 0.6))
  return new Set([...df.entries()].filter(([, n]) => n > limit).map(([t]) => t))
}

/**
 * 实质重合度：这句话里的词元，有多大比例能在被引块里找到。
 * 按词元去重，并剔掉到处都是的词——否则「云梯」「文件」会让随便哪一块都及格。
 */
export function overlapRatio(sentence: string, blockText: string, common: Set<string>): number {
  const terms = [...new Set(tokenize(sentence))].filter((t) => !common.has(t))
  if (terms.length === 0) return 0
  const inBlock = new Set(tokenize(blockText))
  return terms.filter((t) => inBlock.has(t)).length / terms.length
}

/** D6 定的阈值，不要在这一天另定一个 */
export const MIN_OVERLAP = 0.3

/**
 * 引用校验：模型说的出处不算数，代码回查过才算数。两道闸都来自 D6：
 *
 * 1. 编号必须落在本次发出的闭集 1..k 里（模型编引用最常见的形态就是编一个大一号的编号）；
 * 2. 被引的那一块必须与这句话有足够的实质重合，比对的是 `chunk.text` **原文**——
 *    用户点开引用看到的是原文，校验就必须按原文来。
 */
export function verifyCitations(
  text: string,
  blocks: Block[]
): { citations: Citation[]; rejected: string[] } {
  const byNumber = new Map(blocks.map((b) => [b.n, b]))
  const common = commonTerms(blocks)
  const citations: Citation[] = []
  const rejected: string[] = []

  for (const sentence of text.split(/(?<=[。！？\n])/)) {
    for (const m of sentence.matchAll(/\[(\d+)\]/g)) {
      const n = Number(m[1])
      const block = byNumber.get(n)
      if (!block) {
        rejected.push(`[${n}] 编号不存在（本次只发出了 1..${blocks.length}）`)
        continue
      }
      const bare = sentence.replace(/\[\d+\]/g, '')
      const ratio = overlapRatio(bare, block.chunk.text, common)
      if (ratio < MIN_OVERLAP) {
        rejected.push(
          `[${n}] 与这句话的实质重合度只有 ${ratio.toFixed(2)}，低于阈值 ${MIN_OVERLAP}`
        )
        continue
      }
      citations.push({
        n,
        chunkId: block.chunk.chunkId,
        sentence: bare.trim(),
        overlap: Number(ratio.toFixed(3)),
      })
    }
  }
  return { citations, rejected }
}

/** 唯一的生成出口。MOCK 判断在最前面，真实分支一行都不执行 */
export async function answerQuestion(
  question: string,
  used: Candidate[],
  cfg: RagConfig
): Promise<AnswerResult> {
  if (used.length === 0) {
    // 检索侧就拒答：两路都没有一条过门槛。这比让模型对着一堆不相干材料硬答要好得多
    return { answer: REFUSAL, refused: true, citations: [], rejectedCitations: [] }
  }

  const blocks = toBlocks(used)
  let text: string
  if (isMock()) {
    text = [
      '根据检索到的资料：',
      ...blocks.map((b) => `- ${bestSentence(b.chunk.text, question)}[${b.n}]`),
      '',
      '（离线模板拼接：MOCK=1 时不调用模型，只把命中块里最相关的一句摘出来带上出处。）',
    ].join('\n')
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
    const { system, user } = buildPrompt(question, blocks, cfg)
    const res = await new Anthropic({ apiKey }).messages.create({
      model: cfg.generation.model,
      max_tokens: 1024,
      temperature: 0, // 知识库问答要的是可复现，不是文采
      system,
      messages: [{ role: 'user', content: user }],
    })
    text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
  }

  const { citations, rejected } = verifyCitations(text, blocks)
  // 没通过校验的编号就地抹掉，绝不原样透给用户——错误的出处比没有出处更危险。
  // 把 [n] 换成 chunkId 则是另一件事：用户看到的编号必须是能点开的那个
  let cleaned = text.replace(/\[(\d+)\]/g, (whole, digits: string) => {
    const hit = citations.find((c) => c.n === Number(digits))
    return hit ? `[${hit.chunkId}]` : ''
  })
  if (citations.length === 0) cleaned = REFUSAL

  return {
    answer: cleaned,
    refused: cleaned.startsWith(REFUSAL),
    citations,
    rejectedCitations: rejected,
  }
}
