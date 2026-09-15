import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 解析（D3）+ 按标题切块（D4/D7/D8 的第一周参数），本天不改这一段。
 *
 * 从 D8 的 `corpus.ts` 复制过来，切块参数逐字沿用 D7 的 `rag.config.json`——
 * 复制而不是跨目录引用，是因为每个 lab 都要能 `pnpm install --ignore-workspace` 独立跑起来。
 *
 * **本天新加的只有一件事**：在同一份解析产物上再切一套「父块 / 子块」。
 * 父子索引不是新的解析器，是同一批节点的另一种索引方式——这一点是本天的教学落点。
 */

export type Department = 'product' | 'hr' | 'eng' | 'support'

/** D3 定下的块结构，全课统一，字段名不许改。本天多带两个字段，见下 */
export interface Chunk {
  docId: string
  chunkId: string
  text: string
  headingPath: string[]
  page: number | null
  department: Department
  updatedAt: string
  contentHash: string
  /** 只有子块非空：命中之后按它回填父块。其余索引一律 null */
  parentId: string | null
  /** 上下文块头，进索引的文本是 `header + text`。没加块头时是 null */
  header: string | null
}

export interface Doc {
  docId: string
  title: string
  department: Department
  updatedAt: string
  contentHash: string
  /** 去掉 frontmatter 的正文，块头生成要把它整篇喂给模型 */
  body: string
  nodes: ParsedNode[]
}

export interface ParsedNode {
  headingPath: string[]
  text: string
}

/** 第一周系统的切块参数，逐字取自 D7 的 rag.config.json，改了就没法跟 D7 / D8 比 */
export const WEEK1_CHUNKING = { maxChars: 500, minChars: 60, overlapChars: 60 }

/** 父子索引的子块参数。父块就是标题节点本身，不另切 */
export const CHILD_CHUNKING = { maxChars: 200, overlapChars: 40 }

/** 语料在 lab 根目录，从当前文件往上两级定位；用 process.cwd() 会随你在哪敲命令而变 */
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')

/** 内容指纹：先做换行归一化再 trim，否则同一份文件跨系统上传会被判成「内容变了」（D3 定，D13 用） */
function fingerprint(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16)
}

function parseMarkdown(raw: string, file: string): Doc {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`${file} 缺少 frontmatter`)
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = /^(\w+):\s*(.+)$/.exec(line.trim())
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  for (const key of ['id', 'title', 'department', 'updated']) {
    if (!fields[key]) throw new Error(`${file} 的 frontmatter 缺少 ${key}`)
  }

  const body = match[2].trim()
  const nodes: ParsedNode[] = []
  const headingStack: string[] = []
  let buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (text) nodes.push({ headingPath: headingStack.filter(Boolean), text })
  }
  for (const line of body.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      headingStack.length = Math.min(headingStack.length, level - 1)
      headingStack[level - 1] = heading[2].trim()
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
    contentHash: fingerprint(body),
    body,
    nodes,
  }
}

export function loadDocs(): Doc[] {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort() // 固定顺序，块编号每次跑出来都一样
  if (files.length === 0) throw new Error(`语料目录是空的：${CORPUS_DIR}`)
  return files.map((f) => parseMarkdown(readFileSync(join(CORPUS_DIR, f), 'utf8'), f))
}

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

function makeChunk(
  doc: Doc,
  chunkId: string,
  text: string,
  headingPath: string[],
  parentId: string | null = null
): Chunk {
  return {
    docId: doc.docId,
    chunkId,
    text,
    headingPath,
    page: null, // 只有 PDF 来源有页码，本课语料全是 Markdown
    department: doc.department,
    updatedAt: doc.updatedAt,
    contentHash: doc.contentHash,
    parentId,
    header: null,
  }
}

// ---------------------------------------------------------------------------
// 一、第一周的平铺切块（本天的基线，D7 / D8 / D9 用的就是它）
// ---------------------------------------------------------------------------

export function chunkFlat(doc: Doc): Chunk[] {
  const { maxChars, minChars, overlapChars } = WEEK1_CHUNKING
  const chunks: Chunk[] = []
  let seq = 0
  for (const node of doc.nodes) {
    const header = node.headingPath.join(' > ')
    const withHeader = header ? `${header}\n${node.text}` : node.text
    const last = chunks[chunks.length - 1]
    // 太短的小节并进上一块：一块只有一行标题没有检索价值
    if (last && node.text.length < minChars && last.text.length + withHeader.length <= maxChars) {
      last.text = `${last.text}\n${node.text}`
      continue
    }
    for (const part of splitLong(withHeader, maxChars, overlapChars)) {
      seq += 1
      chunks.push(
        makeChunk(doc, `${doc.docId}#c${String(seq).padStart(2, '0')}`, part, node.headingPath)
      )
    }
  }
  return chunks
}

// ---------------------------------------------------------------------------
// 二、父子索引（本天的第一个新东西）
// ---------------------------------------------------------------------------

export interface ParentChildIndex {
  /** 进检索的那一批：小块 */
  children: Chunk[]
  /** 命中子块后按 parentId 回填的大块，key 是 parentId */
  parents: Map<string, Chunk>
}

/**
 * 父子索引：**检索单位**和**上下文单位**不是同一个东西。
 *
 * - 子块小（200 字），一块只讲一件事，被查询词命中时信噪比高，名次容易靠前。
 * - 父块大（整个标题节点），命中之后原样回填，模型看到的是完整的一段而不是半句话。
 *
 * 关键在于父块**不进索引**——它只在装上下文的时候出场。这就是为什么父子索引
 * 既能拿到小块的精度，又不用付「小块上下文残缺」的代价。
 * 代价在别处：同一个父块可能被它的好几个子块同时命中，装上下文时要按 parentId 去重，
 * 否则一个父块会被重复塞进提示词好几遍（见 evaluate.ts 的 packContext）。
 */
export function chunkParentChild(doc: Doc): ParentChildIndex {
  const { maxChars, overlapChars } = CHILD_CHUNKING
  const children: Chunk[] = []
  const parents = new Map<string, Chunk>()
  let parentSeq = 0
  let childSeq = 0

  for (const node of doc.nodes) {
    parentSeq += 1
    const parentId = `${doc.docId}#p${String(parentSeq).padStart(2, '0')}`
    const heading = node.headingPath.join(' > ')
    const parentText = heading ? `${heading}\n${node.text}` : node.text
    parents.set(parentId, makeChunk(doc, parentId, parentText, node.headingPath))

    // 子块也把标题路径拼在块首，跟平铺块保持同一套约定（D7 定的切块口径）
    for (const part of splitLong(node.text, maxChars, overlapChars)) {
      childSeq += 1
      children.push(
        makeChunk(
          doc,
          `${doc.docId}#k${String(childSeq).padStart(2, '0')}`,
          heading ? `${heading}\n${part}` : part,
          node.headingPath,
          parentId
        )
      )
    }
  }
  return { children, parents }
}
