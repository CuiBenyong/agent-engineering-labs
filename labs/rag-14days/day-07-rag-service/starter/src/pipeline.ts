import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RagConfig } from './config'

/**
 * 摄取链路的前半段：解析（D3）与切块（D4）。
 *
 * 这两步在这里合成一个文件，是因为它们共用同一组数据结构，而且都只属于摄取链路——
 * 查询链路一行都用不到。模块边界画在「谁能被单独换掉」上：换解析器不该动切块器，
 * 换切块器不该动向量化，但它们俩一起构成「文档进来」这条链路的一段。
 */

export type Department = 'product' | 'hr' | 'eng' | 'support'

/** D3 定下的解析节点：一段正文 + 它在文档里的标题路径 */
export interface ParsedNode {
  headingPath: string[]
  text: string
}

export interface ParsedDoc {
  docId: string
  title: string
  department: Department
  updatedAt: string
  /** 整篇内容的指纹（sha256 前 16 位），D13 的增量同步靠它 */
  contentHash: string
  nodes: ParsedNode[]
}

/** D3 定下的块结构，全课统一，字段名不许改 */
export interface Chunk {
  docId: string
  chunkId: string
  text: string
  headingPath: string[]
  /** 只有 PDF 来源才有页码，Markdown 来源一律 null */
  page: number | null
  department: Department
  updatedAt: string
  contentHash: string
}

export type Chunker = (doc: ParsedDoc) => Chunk[]

/**
 * 内容指纹：整篇文档原文的 sha256 前 16 位（口径来自 D3，不要在这一天另定一个）。
 *
 * 先做换行归一化再算。同一份文档从 Windows 机器上传一次、从 Mac 上传一次，
 * 字节不同但内容相同——不归一化的话每次同步都会判定成「变了」，白重算一遍全库。
 * D13 的增量同步就靠这个值判断哪些文档需要重算。
 */
export function contentHash(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').trim()
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

function parseFrontmatter(
  raw: string,
  file: string
): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`${file} 缺少 frontmatter`)
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = /^(\w+):\s*(.+)$/.exec(line.trim())
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  return { fields, body: match[2].trim() }
}

/**
 * Markdown 解析器：按标题层级把正文切成节点序列，每个节点带上它的标题路径。
 *
 * D3 讲了三种来源（PDF / HTML / Markdown）都要归一成同一种节点序列。这里只接了
 * Markdown 一种实现，但**接口就是那个接口**：再加一个 PDF 解析器时，
 * 只要它也吐出 ParsedNode[]，后面的切块、向量化、入库一行都不用改。
 */
export function parseMarkdown(raw: string, file: string): ParsedDoc {
  const { fields, body } = parseFrontmatter(raw, file)
  for (const key of ['id', 'title', 'department', 'updated']) {
    if (!fields[key]) throw new Error(`${file} 的 frontmatter 缺少 ${key}`)
  }

  const nodes: ParsedNode[] = []
  const headingStack: string[] = []
  let buffer: string[] = []

  const flush = (): void => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (text) nodes.push({ headingPath: [...headingStack], text })
  }

  for (const line of body.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      headingStack.length = Math.min(headingStack.length, level - 1)
      headingStack[level - 1] = heading[2].trim()
      // 中间层级可能是空的（从 # 直接跳到 ###），补空串免得路径里出现 undefined
      for (let i = 0; i < headingStack.length; i += 1) headingStack[i] ??= ''
      continue
    }
    buffer.push(line)
  }
  flush()

  return {
    docId: fields.id,
    title: fields.title,
    department: fields.department as Department,
    updatedAt: fields.updated,
    contentHash: contentHash(raw),
    nodes,
  }
}

export function loadDocs(dir: string): ParsedDoc[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort() // 固定顺序：块编号要可复现，不能随文件系统的返回顺序变
  const docs = files.map((f) => parseMarkdown(readFileSync(join(dir, f), 'utf8'), f))
  if (docs.length === 0) throw new Error(`语料目录是空的：${dir}`)
  return docs
}

function makeChunk(doc: ParsedDoc, seq: number, headingPath: string[], text: string): Chunk {
  return {
    docId: doc.docId,
    // chunkId 的格式全课统一：doc-003#c07。带上文档号，单看一个 id 就知道它属于谁
    chunkId: `${doc.docId}#c${String(seq).padStart(2, '0')}`,
    text,
    headingPath: headingPath.filter(Boolean),
    page: null,
    department: doc.department,
    updatedAt: doc.updatedAt,
    contentHash: doc.contentHash,
  }
}

/** 把过长的一段按字符切开，尾部留 overlap 个字符的重叠，避免正好切断一句话 */
function splitLong(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    parts.push(text.slice(start, start + maxChars))
    if (start + maxChars >= text.length) break
    start += maxChars - overlapChars
  }
  return parts
}

export function createChunker(cfg: RagConfig): Chunker {
  const { strategy, maxChars, minChars, overlapChars } = cfg.chunking

  if (strategy === 'fixed') {
    // 定长滑窗：完全不看结构，把全文拼起来按字符切。留在这里不是因为它好，
    // 而是因为它是对照组——没有它，你说不清「按结构切」到底赢在哪。
    return (doc) => {
      const whole = doc.nodes.map((n) => n.text).join('\n')
      return splitLong(whole, maxChars, overlapChars).map((text, i) =>
        makeChunk(doc, i + 1, [], text)
      )
    }
  }

  // 练习 1：实现「按标题层级切」。
  //
  // doc.nodes 是 D3 的解析结果，每个节点自带 headingPath。你要做三件事：
  //   a) 每个节点切成一块，用 splitLong 处理超长节点；
  //   b) 把标题路径拼进块的正文开头（`标题 > 子标题\n正文`）——块被单独检索出来时，
  //      读者和模型都需要知道它出自哪一节；
  //   c) 正文短于 minChars 的节点往前一块合并，否则会切出一堆没有信息量的碎块。
  //
  // 提示：makeChunk(doc, seq, headingPath, text) 已经写好，seq 从 1 开始连续编号。
  //
  // 现在的默认实现是「整篇一块」：能跑，但引用粒度大到没有意义——
  // 自测里「30 篇切出多少块」那一项会停在 30，做完这个练习才会变成一百多。
  void minChars
  return (doc) => [makeChunk(doc, 1, [], doc.nodes.map((n) => n.text).join('\n'))]
}
