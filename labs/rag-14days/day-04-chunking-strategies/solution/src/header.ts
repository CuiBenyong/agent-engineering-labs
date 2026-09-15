import type { Doc } from './corpus'
import type { Chunk, ChunkSet } from './chunkers'

/**
 * 上下文块头：给每一块补一句「它在全文里是哪一部分」的定位说明，再拼回块首去索引。
 * 补救的是切开之后块变得不可读这个问题——「保留期是 30 天」这种句子单看不知道说的是谁的保留期，
 * 补上「《网盘与文件管理》回收站」之后，它就能被「回收站能留多久」这样的问题检索到。
 *
 * 代价有两笔：每块多出的 token 会一直留在索引和上下文里；真实模式下每块还要过一次模型。
 * 完整实现与评估在第十一天，这里只做到能量出这两笔账。
 */

/** 离线用规则拼：拿第三天保下来的标题路径直接生成，不调任何 API */
function ruleHeader(doc: Doc, chunk: Chunk): string {
  const path = chunk.headingPath.length > 0 ? chunk.headingPath.join(' > ') : '正文'
  return `《${doc.title}》${path}：`
}

/** 真实模式下让一个便宜模型读全文后写一句定位说明；离线时退回规则版 */
async function modelHeader(doc: Doc, chunk: Chunk): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('缺少 ANTHROPIC_API_KEY（或用 MOCK=1 离线运行）')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content:
          `全文：\n${doc.body}\n\n其中一段：\n${chunk.text}\n\n` +
          '用一句不超过 40 字的中文说明这一段在全文里讲的是什么，只输出这句话本身。',
      },
    ],
  })
  const block = res.content[0]
  return block.type === 'text' ? `${block.text.trim()}：` : ruleHeader(doc, chunk)
}

export async function withContextualHeaders(docs: Doc[], set: ChunkSet): Promise<ChunkSet> {
  const byId = new Map(docs.map((d) => [d.id, d]))
  const chunks: Chunk[] = []
  for (const chunk of set.chunks) {
    const doc = byId.get(chunk.docId)
    if (!doc) continue
    const header = process.env.MOCK === '1' ? ruleHeader(doc, chunk) : await modelHeader(doc, chunk)
    chunks.push({ ...chunk, text: `${header}\n${chunk.text}` })
  }
  return { name: `${set.name}+header`, chunks, parents: set.parents }
}
