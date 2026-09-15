import type { Chunk } from './corpus'

/** 一条引用。三个字段缺一不可：定位到块、定位到文档、给人看的标题。 */
export interface Citation {
  index: number
  chunkId: string
  sourceId: string
  sourceTitle: string
}

/**
 * 引用可观测指标。「模型引用了一个不存在的编号」不是一句吐槽，是一个要上看板的数字：
 * 它一旦抬头，说明检索质量或提示词退化了，而回答表面上看还是通顺的。
 */
export const citationMetrics = { answers: 0, withCitation: 0, hallucinated: 0 }

/**
 * 把检索结果拼成给模型的上下文。两个决定都是有代价的：
 *
 * 1. **编号按相关度给**（最相关的是 [1]），这样模型引用的编号和你的排序是一回事。
 * 2. **摆放顺序反过来**：最相关的那一条放在最后、紧挨着问题。长上下文里模型对开头和结尾
 *    最敏感，中间那一段最容易被忽略（lost in the middle），所以别把最好的那条埋在中间。
 */
export function buildContext(
  chunks: Chunk[],
  question: string
): { prompt: string; citations: Citation[] } {
  const citations = chunks.map((chunk, index) => ({
    index: index + 1,
    chunkId: chunk.chunkId,
    sourceId: chunk.sourceId,
    sourceTitle: chunk.sourceTitle,
  }))
  const blocks = chunks
    .map((chunk, index) => `[${index + 1}] （${chunk.sourceTitle}）${chunk.content}`)
    .reverse()
  const prompt =
    '下面是检索到的资料，每条前面的方括号是它的编号。\n\n' +
    `${blocks.join('\n\n')}\n\n` +
    '只依据上面的资料回答，用到哪条就在句末标上它的编号，例如 [1]。' +
    `资料里没有的就说不知道，不要编。\n\n问题：${question}`
  return { prompt, citations }
}

/**
 * 后处理：把回答里不存在的引用编号剔除，并计入指标。
 *
 * 模型确实会引用一个你根本没给它的编号——你给了 5 条，它写了个 [9]。留着它比没有引用更糟：
 * 读者点不开，会以为整套引用都是装饰。
 */
export function stripHallucinatedCitations(
  answer: string,
  citations: Citation[]
): { text: string; hallucinated: number[] } {
  // 练习 4：把回答里不存在的引用编号剔除，并把「这一条回答里出现过幻觉引用」计进
  // `citationMetrics.hallucinated`。
  // 提示：`answer.replace(/\[(\d+)\]/g, (whole, digits) => ...)`，
  //       编号不在 citations 里就返回空串并记一笔；顺手把留下的空格贴回标点。
  //
  // 下面这版原样返回，模型编出来的 [9] 会直接发给用户——读者点不开，
  // 会认为整套引用都是装饰。跑一次自检看第 5 项。
  citationMetrics.answers += 1
  if (/\[\d+\]/.test(answer)) citationMetrics.withCitation += 1
  return { text: answer, hallucinated: [] }
}

/** 回答末尾那份来源清单。只列回答里真正引用到的编号。 */
export function renderSources(answer: string, citations: Citation[]): string {
  const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
  const lines = citations
    .filter((citation) => used.has(citation.index))
    .map((citation) => `[${citation.index}] ${citation.sourceTitle}（${citation.chunkId}）`)
  return lines.length === 0 ? '' : `\n\n来源：\n${lines.join('\n')}`
}
