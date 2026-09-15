import Anthropic from '@anthropic-ai/sdk'
import { getEncoding } from 'js-tiktoken'
import type { Chunk } from './corpus'
import { tokenize } from './tokenize'

/**
 * 上下文组装：排序 → 去重 → 控预算 → 首尾优先重排 → 编号。
 * 编号是今天所有东西的地基：模型只被允许引用这里发出去的编号，
 * 校验时再拿编号回查原文。编号一旦发出去就不能变，所以它是**呈现顺序**的序号。
 */

const enc = getEncoding('cl100k_base')

export function countTokens(text: string): number {
  return enc.encode(text).length
}

export interface Scored {
  chunk: Chunk
  score: number
}

export interface Block {
  /** 给模型看的块编号，从 1 开始，等于它在提示词里出现的位置 */
  n: number
  chunk: Chunk
  /** 实际放进提示词的文本，可能是压缩过的；校验时仍然拿 chunk.text 原文比对 */
  text: string
  score: number
}

export interface AssembleOptions {
  /** 上下文的 token 预算，只算材料本身，不含指令与问题 */
  budget?: number
  /** 最多放几块，防止预算很大时塞进一堆低分噪声 */
  maxBlocks?: number
}

export interface AssembleResult {
  blocks: Block[]
  usedTokens: number
  /** 因为重复被丢掉的块 */
  deduped: string[]
  /** 因为超预算被丢掉的块 */
  overBudget: string[]
}

/** 归一化之后完全一样的两块视为重复：语料里同一段话经常在手册和问答里各出现一次 */
function fingerprint(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，。、；：！？（）()*#>-]/g, '')
}

/**
 * 「中间位置的材料容易被忽略」是长上下文里反复被观察到的现象：
 * 模型对开头和结尾的材料明显更敏感，正中间的最容易被读漏。
 * 应对办法不是把它讲成玄学，而是**把最重要的放到两端**：
 * 第 1 名放开头，第 2 名放结尾，第 3 名放第二位，第 4 名放倒数第二位……
 * 这样按分数排下来，越靠中间的块本来就越不重要，被读漏的代价最小。
 */
export function interleaveHeadTail<T>(ranked: T[]): T[] {
  // 练习 1（后半）：把按分数排好的数组重排成「第 1 名开头、第 2 名结尾、第 3 名第二位……」。
  // 提示：奇偶下标分别 push 到 head 和 unshift 到 tail，最后拼起来。
  // 现在直接原样返回，自测第一项会告诉你「第 2 名应该在结尾」没做到。
  return ranked
}

export function assemble(scored: Scored[], options: AssembleOptions = {}): AssembleResult {
  const budget = options.budget ?? 1200
  const maxBlocks = options.maxBlocks ?? 6

  // 同分时按 chunkId 定序，否则不同运行环境的遍历顺序会让块编号飘
  const ranked = [...scored].sort(
    (a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId)
  )

  const seen = new Set<string>()
  const deduped: string[] = []
  const overBudget: string[] = []
  const picked: Scored[] = []
  let usedTokens = 0

  for (const item of ranked) {
    if (picked.length >= maxBlocks) {
      overBudget.push(item.chunk.chunkId)
      continue
    }
    const key = fingerprint(item.chunk.text)
    if (seen.has(key)) {
      deduped.push(item.chunk.chunkId)
      continue
    }
    // 练习 1（前半）：用 countTokens 算这一块的开销，超预算就跳过它（不要 break，
    // 后面可能还有一块小的塞得下），并把 chunkId 记进 overBudget。
    // 现在不看预算照单全收，materials 可能撑爆上下文——自测第一项会打印实际用了多少 token。
    const cost = countTokens(item.chunk.text)
    seen.add(key)
    usedTokens += cost
    picked.push(item)
  }

  const blocks = interleaveHeadTail(picked).map((item, i) => ({
    n: i + 1,
    chunk: item.chunk,
    text: item.chunk.text,
    score: item.score,
  }))

  return { blocks, usedTokens, deduped, overBudget }
}

const COMPRESS_MODEL = 'claude-haiku-4-5-20251001'

const COMPRESS_SYSTEM = [
  '你在做上下文压缩。下面给你一个问题和一段资料。',
  '任务：把资料里与这个问题无关的句子删掉，保留下来的句子必须与原文逐字一致，不要改写、不要总结、不要补充。',
  '如果整段资料都与问题无关，输出空字符串。只输出保留下来的内容，不要任何解释。',
].join('\n')

/**
 * 上下文压缩：让一个便宜的小模型先把无关句子删掉。
 *
 * 省钱只是顺带的，主要收益是**噪声变少、准确率变高**：塞进去的无关句子越少，
 * 模型把两段材料的数字张冠李戴的机会就越小。
 *
 * 代价有三个，正文里都讲了：多一次调用（延迟）、小模型可能删错（召回损失）、
 * 以及最危险的——**小模型可能顺手改写**。所以这里做了一道硬约束：
 * 保留下来的每一句都必须能在原文里逐字找到，找不到就整块回退成未压缩版本。
 * 引用校验永远拿 `chunk.text` 原文比对，压缩产物只影响提示词，不影响可验证性。
 */
export async function compressBlocks(question: string, blocks: Block[]): Promise<Block[]> {
  const wanted = new Set(tokenize(question))

  if (process.env.MOCK === '1') {
    return blocks.map((block) => ({ ...block, text: keepRelevantSentences(block.text, wanted) }))
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const client = new Anthropic({ apiKey })

  const compressed = await Promise.all(
    blocks.map(async (block) => {
      const res = await client.messages.create({
        model: COMPRESS_MODEL,
        max_tokens: 1024,
        temperature: 0,
        system: COMPRESS_SYSTEM,
        messages: [{ role: 'user', content: `问题：${question}\n\n资料：\n${block.text}` }],
      })
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
      return { ...block, text: verbatimOrFallback(text, block.text) }
    })
  )
  return compressed
}

/** 压缩产物必须是原文的子集：任何一句在原文里找不到，就整块回退，绝不把改写过的内容当材料 */
function verbatimOrFallback(compressed: string, original: string): string {
  if (compressed.length === 0) return original
  const flat = original.replace(/\s+/g, '')
  const lines = compressed.split('\n').filter((l) => l.trim().length > 0)
  const allVerbatim = lines.every((line) => flat.includes(line.replace(/\s+/g, '')))
  return allVerbatim ? compressed : original
}

/**
 * MOCK 下的压缩是规则版：保留标题行，以及与问题有词元重合的句子。
 * 它换掉的只是「谁来判断这句有没有用」，压缩本身的语义和上面的硬约束完全一样——
 * 保留下来的句子仍然逐字来自原文。
 */
function keepRelevantSentences(text: string, wanted: Set<string>): string {
  const [heading, ...rest] = text.split('\n')
  const kept = rest.filter((line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return false
    return tokenize(trimmed).some((t) => wanted.has(t))
  })
  return kept.length === 0 ? text : [heading, ...kept].join('\n')
}
