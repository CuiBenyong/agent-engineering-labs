import type { Chunk, Doc } from './corpus'
import { chunkFlat, chunkParentChild } from './corpus'
import { countTokens } from './cost'

/**
 * 同一批文档，四种索引结构 + 一套摘要索引。
 *
 * 一书多目录：书没变，变的是你按什么建卡片。按章节建一套、按摘要建一套、
 * 给每张卡片补一句「它在书里是哪一部分」再建一套——检索走哪一套，结果就不一样。
 */

// ---------------------------------------------------------------------------
// 上下文块头
// ---------------------------------------------------------------------------

export const HEADER_MODEL = 'claude-sonnet-5'
export const HEADER_MAX_TOKENS = 100

export const HEADER_INSTRUCTION =
  '用一句不超过 40 字的中文说明这一段在全文里讲的是什么、属于哪个主题，只输出这句话本身，不要解释。'

/**
 * 离线模式下的块头：拿 D3 解析时保下来的标题路径直接拼，不调任何模型。
 *
 * **这是本实验最重要的一条边界**：规则块头只有标题词，真实模型写出来的块头会带上
 * 文中没有明说、要通读全文才知道的信息（这一段属于哪条产品线、跟哪个流程衔接）。
 * 所以离线模式下量到的块头收益，**不能**当成真实上下文检索的收益。
 */
export function ruleHeader(doc: Doc, chunk: Chunk): string {
  const path = chunk.headingPath.length > 0 ? chunk.headingPath.join(' > ') : '正文'
  return `《${doc.title}》${path}：`
}

/**
 * 真实模式：让模型读完整篇文档再给这一块写一句定位说明。
 *
 * 省钱的关键在 `cache_control`：**把整篇文档放在提示词的最前面并标记为可缓存**，
 * 同一篇文档的第二块起就只付缓存读取价，而不是重新付一次整篇的输入价。
 * 顺序不能反——缓存命中是按前缀匹配的，块内容必须放在文档后面，
 * 一旦把变化的块放前面，前缀每次都不同，缓存一次都不会命中。
 */
async function modelHeader(doc: Doc, chunk: Chunk): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model: HEADER_MODEL,
    max_tokens: HEADER_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `全文：\n${doc.body}`,
            cache_control: { type: 'ephemeral' }, // 缓存断点：这之前的内容整篇复用
          },
          { type: 'text', text: `其中一段：\n${chunk.text}\n\n${HEADER_INSTRUCTION}` },
        ],
      },
    ],
  })
  const block = res.content[0]
  return block.type === 'text' ? `${block.text.trim()}：` : ruleHeader(doc, chunk)
}

/** 给一批块补上下文块头。离线走规则、在线走模型，两条路产出的是同一个字段 */
export async function withHeaders(docs: Doc[], chunks: Chunk[]): Promise<Chunk[]> {
  const byId = new Map(docs.map((d) => [d.docId, d]))
  const out: Chunk[] = []
  for (const chunk of chunks) {
    const doc = byId.get(chunk.docId)
    if (!doc) throw new Error(`块 ${chunk.chunkId} 找不到它的文档`)

    // 练习 2：给每一块补上下文块头。现在这里原样返回，所以表二里
    //   ③「上下文块头」那一列跟 ②「标题路径」一模一样——块头根本没生成。
    //   `MOCK=1` 时调 ruleHeader（按标题路径拼），否则调 modelHeader（走模型）。
    //   提示：写成 `{ ...chunk, header }`，不要就地改 chunk——同一批块在别的表里还要用。
    void ruleHeader
    void modelHeader
    out.push({ ...chunk, header: null })
  }
  return out
}

/**
 * 进索引的文本。加了块头就把块头拼在最前面，这就是「上下文检索」的全部实现——
 * 手法本身只有这一行，难的是它到底有没有用，以及那笔账划不划算。
 *
 * 注意 `chunk.text` 里**已经带着标题路径**了（D7 切块时就拼进去的），所以本天真正比的是
 * 「标题路径」和「模型写的定位说明」之间的差距，而不是「有没有上下文」。
 */
export function indexTextOf(chunk: Chunk): string {
  return chunk.header ? `${chunk.header}\n${chunk.text}` : chunk.text
}

/**
 * 把块首那行标题路径去掉，还原成「什么上下文都没有的裸块」。
 * 这是 D4 当初比较块头时用的起点（固定长度切法不带任何标题信息），
 * 本天要用它把 D4 那条负收益结论接上，见 index.ts 的第二张表。
 */
export function strippedTextOf(chunk: Chunk): string {
  const path = chunk.headingPath.join(' > ')
  return path && chunk.text.startsWith(`${path}\n`) ? chunk.text.slice(path.length + 1) : chunk.text
}

// ---------------------------------------------------------------------------
// 摘要索引
// ---------------------------------------------------------------------------

export const SUMMARY_MODEL = 'claude-sonnet-5'
export const SUMMARY_INSTRUCTION =
  '用不超过 120 字的中文概括这篇文档讲了什么、覆盖哪些主题，只输出概括本身。'

export interface DocSummary {
  docId: string
  text: string
}

/** 离线摘要：标题 + 全部标题路径 + 每节首句。同样只是替身，不是真摘要 */
function ruleSummary(doc: Doc): string {
  const headings = [...new Set(doc.nodes.map((n) => n.headingPath.join(' > ')).filter(Boolean))]
  const leads = doc.nodes
    .map((n) => n.text.split(/(?<=[。！？])/)[0]?.trim() ?? '')
    .filter(Boolean)
    .slice(0, 3)
  return [`${doc.title}（${doc.department}）`, headings.join('、'), leads.join('')].join('\n')
}

async function modelSummary(doc: Doc): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: `${doc.body}\n\n${SUMMARY_INSTRUCTION}` }],
  })
  const block = res.content[0]
  return block.type === 'text' ? block.text.trim() : ruleSummary(doc)
}

export async function buildSummaries(docs: Doc[]): Promise<DocSummary[]> {
  const out: DocSummary[] = []
  for (const doc of docs) {
    const text = process.env.MOCK === '1' ? ruleSummary(doc) : await modelSummary(doc)
    out.push({ docId: doc.docId, text })
  }
  return out
}

// ---------------------------------------------------------------------------
// 五种索引的装配
// ---------------------------------------------------------------------------

export interface BuiltIndex {
  name: string
  /** 进检索的块 */
  chunks: Chunk[]
  /** 命中之后按 parentId 回填的父块；平铺索引是空 Map */
  parents: Map<string, Chunk>
  /** 建这套索引一共要 embedding 多少 token（一次性成本的一部分） */
  indexTokens: number
}

function tokensOf(chunks: Chunk[]): number {
  return chunks.reduce((sum, c) => sum + countTokens(indexTextOf(c)), 0)
}

export async function buildIndexes(docs: Doc[]): Promise<BuiltIndex[]> {
  const flat = docs.flatMap(chunkFlat)
  const pc = docs.map(chunkParentChild)
  const children = pc.flatMap((x) => x.children)
  const parents = new Map<string, Chunk>()
  for (const x of pc) for (const [id, chunk] of x.parents) parents.set(id, chunk)

  const flatHeaded = await withHeaders(docs, flat)
  const childrenHeaded = await withHeaders(docs, children)

  return [
    { name: 'D9 配置（平铺块）', chunks: flat, parents: new Map(), indexTokens: tokensOf(flat) },
    { name: '父子索引', chunks: children, parents, indexTokens: tokensOf(children) },
    {
      name: '上下文检索（平铺块+块头）',
      chunks: flatHeaded,
      parents: new Map(),
      indexTokens: tokensOf(flatHeaded),
    },
    {
      name: '父子索引+块头',
      chunks: childrenHeaded,
      parents,
      indexTokens: tokensOf(childrenHeaded),
    },
    // 同一套带块头的索引，只改一件事：装上下文时用原文，不带块头。
    // 块头是给检索器看的，模型不需要它——这一行专门量这句话值多少
    {
      name: '上下文检索（块头只进索引）',
      chunks: flatHeaded,
      parents: new Map(),
      indexTokens: tokensOf(flatHeaded),
    },
  ]
}
