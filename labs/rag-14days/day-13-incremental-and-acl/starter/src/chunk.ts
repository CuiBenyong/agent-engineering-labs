import { createHash } from 'node:crypto'

export type Department = 'product' | 'hr' | 'eng' | 'support'

/**
 * 全课统一的块结构（字段名由 D3 定下，14 天不许改）：
 *
 *   { docId, chunkId, text, headingPath, page, department, updatedAt, contentHash }
 *
 * 今天只多用它，不改它。`contentHash` 是本天的主角——增量同步全靠它。
 */
export interface Chunk {
  docId: string
  chunkId: string
  text: string
  headingPath: string[]
  page: number | null
  department: Department
  updatedAt: string
  contentHash: string
}

/**
 * 内容指纹：整篇文档原文的 sha256 前 16 位。**逐字沿用 D3 的实现，不要另发明一套。**
 *
 * 两个刻意的决定：
 * 1. 指纹算在**整篇文档**上。先用它判断「这篇要不要重算」，判断为要，才去做块级的活。
 * 2. **先做换行归一化再算**。同一份文件从 Windows 传一次、从 Mac 传一次，字节不同但内容相同；
 *    不归一化的话每次同步都判成「变了」，白白重算一遍全库——这是增量同步最贵的一个 bug，
 *    因为它不报错，只是让你的账单看起来像在做全量重建。
 */
export function contentHash(raw: string): string {
  // 练习 1：把原文归一化之后再算指纹。
  // 现在这一版直接拿原始字节算，所以同一份文件从 Windows 传一次就会被判成「变了」。
  // 提示：先把 \r\n 换成 \n，再 trim 掉首尾空白，然后才 sha256。改完看自测第 2 项。
  const normalized = raw
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

/** 块编号统一形如 doc-005#c07，两位补零 */
export function chunkId(docId: string, index: number): string {
  return `${docId}#c${String(index + 1).padStart(2, '0')}`
}

interface Section {
  headingPath: string[]
  text: string
}

/** 按标题层级切小节，标题路径进元数据。做法与 D4 的「按结构切」一致，今天不再讨论切法 */
function splitSections(body: string): Section[] {
  const sections: Section[] = []
  const stack: string[] = []
  let buffer: string[] = []
  let path: string[] = []

  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) sections.push({ headingPath: [...path], text })
    buffer = []
  }

  for (const line of body.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      stack.length = Math.min(stack.length, level - 1)
      stack[level - 1] = heading[2].trim()
      path = stack.filter(Boolean)
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

const MAX_CHARS = 700

function hardSplit(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max))
  return out
}

export interface Sourceish {
  id: string
  department: Department
  updated: string
  body: string
  raw: string
}

/** 把一篇文档切成块。同一篇文档的所有块共享同一个 contentHash */
export function chunkDocument(doc: Sourceish): Chunk[] {
  const hash = contentHash(doc.raw)
  const chunks: Chunk[] = []
  for (const section of splitSections(doc.body)) {
    for (const text of hardSplit(section.text, MAX_CHARS)) {
      chunks.push({
        docId: doc.id,
        chunkId: chunkId(doc.id, chunks.length),
        text: text.trim(),
        headingPath: section.headingPath,
        page: null, // 本课语料全是 Markdown，页码只有 PDF 来源才有
        department: doc.department,
        updatedAt: doc.updated,
        contentHash: hash,
      })
    }
  }
  return chunks
}
