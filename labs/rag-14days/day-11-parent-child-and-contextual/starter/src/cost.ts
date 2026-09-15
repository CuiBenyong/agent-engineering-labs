import { getEncoding } from 'js-tiktoken'
import type { Chunk, Doc } from './corpus'

const ENC = getEncoding('cl100k_base')
export const countTokens = (text: string): number => ENC.encode(text).length

/**
 * 成本账。**这里唯一由实测撑着的是 token 数**，金额随单价而变。
 *
 * 下面五个单价是**占位值**，不是任何厂商的真实报价——定价会变，写死在代码里
 * 只会让读者拿到一个看起来合理的过期数字。想看真实金额，把你用的那家的价目
 * 抄进 `.env` 再跑一遍；教学重点是**占比与它随配置怎么翻转**，不是绝对金额。
 */
const price = (key: string, fallback: number): number => Number(process.env[key] ?? fallback)

export const PRICES = {
  /** 生成模型输入，美元 / 百万 token */
  genIn: () => price('PRICE_GEN_IN', 3),
  /** 生成模型输出 */
  genOut: () => price('PRICE_GEN_OUT', 15),
  /** 缓存写入：比普通输入贵一点，因为要额外存一份 */
  cacheWrite: () => price('PRICE_CACHE_WRITE', 3.75),
  /** 缓存命中读取：这就是上下文检索能便宜下来的全部原因 */
  cacheRead: () => price('PRICE_CACHE_READ', 0.3),
  /** embedding */
  embed: () => price('PRICE_EMBED', 0.02),
}

const usd = (tokens: number, perMillion: number): number => (tokens / 1_000_000) * perMillion

export interface BuildCost {
  chunkCount: number
  /** 不用缓存时：每块都要把整篇文档重新读一遍 */
  naiveInputTokens: number
  /** 用缓存时：整篇文档每篇只付一次写入价，其余块付读取价 */
  cacheWriteTokens: number
  cacheReadTokens: number
  /** 每块之外的增量输入（块正文 + 指令），这部分缓存不了 */
  freshInputTokens: number
  outputTokens: number
  embedTokens: number
  naiveUsd: number
  cachedUsd: number
  savedRatio: number
}

/**
 * 一次性建索引成本：给每一块生成上下文块头要花多少钱。
 *
 * 关键在于**同一篇文档被读了多少遍**。一篇文档切出 n 块，朴素做法要把整篇读 n 遍；
 * 开了提示词缓存，整篇只在第一块时写一次缓存，后面 n-1 块按缓存读取价过一遍。
 * 缓存读取价通常是输入价的十分之一上下，所以块越碎、这笔账省得越多——
 * 这也是为什么「上下文检索贵得上不起」在开了缓存之后往往不成立。
 */
export function estimateBuildCost(
  docs: Doc[],
  chunks: Chunk[],
  indexTokens: number,
  header: { instruction: string; maxTokens: number }
): BuildCost {
  const byId = new Map(docs.map((d) => [d.docId, d]))
  const docTokens = new Map(docs.map((d) => [d.docId, countTokens(`全文：\n${d.body}`)]))
  const instructionTokens = countTokens(header.instruction)

  let naiveInputTokens = 0
  let cacheReadTokens = 0
  let freshInputTokens = 0
  const chunksPerDoc = new Map<string, number>()

  for (const chunk of chunks) {
    const doc = byId.get(chunk.docId)
    if (!doc) continue
    const full = docTokens.get(chunk.docId) ?? 0
    const seen = chunksPerDoc.get(chunk.docId) ?? 0
    chunksPerDoc.set(chunk.docId, seen + 1)

    naiveInputTokens += full
    // 练习 5：把提示词缓存这笔账算出来。现在缓存读取记 0、缓存写入按整篇重写，
    //   跑起来你会看到「开缓存」比「不用缓存」还贵、省下来的比例是负数。
    //     a. 一篇文档的**第一块**要付一次缓存写入（整篇的 token）；
    //     b. 第二块起只付缓存读取（同样是整篇的 token，但单价低一个数量级）。
    //   seen 就是这一篇已经处理过几块，用它区分第一块和后续块。
    void seen
    freshInputTokens += countTokens(`其中一段：\n${chunk.text}`) + instructionTokens
  }

  const cacheWriteTokens = naiveInputTokens
  // 块头限长 100 token，真实输出通常远小于它；按上限估是保守口径
  const outputTokens = chunks.length * header.maxTokens

  const naiveUsd =
    usd(naiveInputTokens + freshInputTokens, PRICES.genIn()) +
    usd(outputTokens, PRICES.genOut()) +
    usd(indexTokens, PRICES.embed())
  const cachedUsd =
    usd(cacheWriteTokens, PRICES.cacheWrite()) +
    usd(cacheReadTokens, PRICES.cacheRead()) +
    usd(freshInputTokens, PRICES.genIn()) +
    usd(outputTokens, PRICES.genOut()) +
    usd(indexTokens, PRICES.embed())

  return {
    chunkCount: chunks.length,
    naiveInputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    freshInputTokens,
    outputTokens,
    embedTokens: indexTokens,
    naiveUsd,
    cachedUsd,
    savedRatio: naiveUsd === 0 ? 0 : 1 - cachedUsd / naiveUsd,
  }
}

export interface QueryCost {
  /** 查询本身要 embedding 一次 */
  queryEmbedTokens: number
  /** 重排读进去的 token（融合后的前 20 条） */
  rerankTokens: number
  /** 生成一次回答的输入：上下文 + 问题 + 系统提示 */
  genInTokens: number
  genOutTokens: number
  usd: number
}

/**
 * 每次查询成本。**块头一旦入库，它就在每一次查询里都要被读一遍**——
 * 先在重排里读，再在上下文里读。这才是上下文检索真正的持续成本，
 * 一次性建索引那笔钱反而是可以摊掉的。
 */
export function estimateQueryCost(
  avgContextTokens: number,
  avgQuestionTokens: number,
  avgRerankTokens: number,
  answerTokens = 300
): QueryCost {
  const genInTokens = avgContextTokens + avgQuestionTokens + 200 // 200 是系统提示的估值
  const cost =
    usd(avgQuestionTokens, PRICES.embed()) +
    usd(avgRerankTokens, PRICES.genIn()) +
    usd(genInTokens, PRICES.genIn()) +
    usd(answerTokens, PRICES.genOut())
  return {
    queryEmbedTokens: avgQuestionTokens,
    rerankTokens: avgRerankTokens,
    genInTokens,
    genOutTokens: answerTokens,
    usd: cost,
  }
}

/** 一次性成本摊到每次查询上，要多少次查询才降到每次查询成本的 10% 以下 */
export function breakEvenQueries(buildUsd: number, perQueryUsd: number): number {
  if (perQueryUsd <= 0) return Infinity
  return Math.ceil(buildUsd / (perQueryUsd * 0.1))
}
