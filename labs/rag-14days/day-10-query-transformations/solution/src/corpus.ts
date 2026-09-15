import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 解析（D3）+ 按标题切块（D4），本天不改。
 *
 * 这个文件是从 D7 的 `pipeline.ts` 复制过来的，切块参数也照抄 D7 的 `rag.config.json`。
 * 复制而不是引用，是因为每个 lab 都要能 `pnpm install --ignore-workspace` 独立跑起来。
 * 本天的教学内容在 `metrics.ts` 与 `judge.ts` 里，这一份读一遍就可以跳过。
 */

export type Department = 'product' | 'hr' | 'eng' | 'support'

export interface ParsedNode {
  headingPath: string[]
  text: string
}

/** D3 定下的块结构，全课统一，字段名不许改 */
export interface Chunk {
  docId: string
  chunkId: string
  text: string
  headingPath: string[]
  page: number | null
  department: Department
  updatedAt: string
}

/** 第一周系统的切块参数，逐字取自 D7 的 rag.config.json，改了就没法跟 D7 比 */
export const WEEK1_CHUNKING = { maxChars: 500, minChars: 60, overlapChars: 60 }

/** 语料在 lab 根目录，从当前文件往上两级定位；用 process.cwd() 会随你在哪敲命令而变 */
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')

interface ParsedDoc {
  docId: string
  title: string
  department: Department
  updatedAt: string
  nodes: ParsedNode[]
}

function parseMarkdown(raw: string, file: string): ParsedDoc {
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

  const nodes: ParsedNode[] = []
  const headingStack: string[] = []
  let buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (text) nodes.push({ headingPath: [...headingStack], text })
  }
  for (const line of match[2].trim().split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      headingStack.length = Math.min(headingStack.length, level - 1)
      headingStack[level - 1] = heading[2].trim()
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
    nodes,
  }
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

function chunkDoc(doc: ParsedDoc): Chunk[] {
  const { maxChars, minChars, overlapChars } = WEEK1_CHUNKING
  const chunks: Chunk[] = []
  let seq = 0
  for (const node of doc.nodes) {
    const header = node.headingPath.filter(Boolean).join(' > ')
    const withHeader = header ? `${header}\n${node.text}` : node.text
    const last = chunks[chunks.length - 1]
    if (last && node.text.length < minChars && last.text.length + withHeader.length <= maxChars) {
      last.text = `${last.text}\n${node.text}`
      continue
    }
    for (const part of splitLong(withHeader, maxChars, overlapChars)) {
      seq += 1
      chunks.push({
        docId: doc.docId,
        chunkId: `${doc.docId}#c${String(seq).padStart(2, '0')}`,
        text: part,
        headingPath: node.headingPath.filter(Boolean),
        page: null,
        department: doc.department,
        updatedAt: doc.updatedAt,
      })
    }
  }
  return chunks
}

/** 把 30 篇语料解析并切成块。文件名排序固定，保证每次跑出来的块编号一致 */
export function loadChunks(): Chunk[] {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
  if (files.length === 0) throw new Error(`语料目录是空的：${CORPUS_DIR}`)
  return files.flatMap((f) => chunkDoc(parseMarkdown(readFileSync(join(CORPUS_DIR, f), 'utf8'), f)))
}
