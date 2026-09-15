import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 语料加载与切块。文档解析那部分来自 D1，本天不改；
 * 新增的是 `splitIntoChunks`——今天检索和引用的最小单位是**块**，不是整篇文档。
 * 切法故意选最朴素的「按二级标题切」，因为今天的重点在生成侧，不在切块（那是 D4 的事）。
 */

export type Department = 'product' | 'hr' | 'eng' | 'support'

export interface Doc {
  id: string
  title: string
  department: Department
  updated: string
  /** 去掉 frontmatter 之后的正文（含 Markdown 标题） */
  body: string
}

/** 字段名沿用 D3 定下的口径，全课统一，不要改名 */
export interface Chunk {
  docId: string
  /** 形如 doc-006#c02 */
  chunkId: string
  text: string
  /** 标题路径，如 ["网盘与文件管理", "上传限制"] */
  headingPath: string[]
  /** 只有 PDF 来源才有页码，Markdown 来源一律 null */
  page: number | null
  department: Department
  updatedAt: string
  /** 整篇文档的内容指纹（sha256 前 16 位），D13 的增量同步靠它 */
  contentHash: string
}

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')

/** 只解析我们自己写的这四个字段，不引第三方 YAML 库：语料格式是固定的，正则足够 */
function parseFrontmatter(raw: string, file: string): Doc {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`${file} 缺少 frontmatter`)
  const [, head, body] = match
  const fields: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const kv = /^(\w+):\s*(.+)$/.exec(line.trim())
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  for (const key of ['id', 'title', 'department', 'updated']) {
    if (!fields[key]) throw new Error(`${file} 的 frontmatter 缺少 ${key}`)
  }
  return {
    id: fields.id,
    title: fields.title,
    department: fields.department as Department,
    updated: fields.updated,
    body: body.trim(),
  }
}

export function loadCorpus(): Doc[] {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort() // 固定顺序，保证每次跑出来的块编号都一样
  const docs = files.map((f) => parseFrontmatter(readFileSync(join(CORPUS_DIR, f), 'utf8'), f))
  if (docs.length === 0) throw new Error(`语料目录是空的：${CORPUS_DIR}`)
  return docs
}

/**
 * 按二级标题切块。每一块都带上一级标题，否则「保留期是 30 天」这种句子
 * 从块里单独拿出来看是没有主语的——这正是 D11 要用上下文块头解决的问题，
 * 今天先用最省事的办法：把标题路径拼回块的开头。
 */
export function splitIntoChunks(doc: Doc): Chunk[] {
  const contentHash = createHash('sha256').update(doc.body).digest('hex').slice(0, 16)
  const lines = doc.body.split('\n')
  const h1 =
    lines
      .find((l) => l.startsWith('# '))
      ?.slice(2)
      .trim() ?? doc.title

  const sections: { heading: string; lines: string[] }[] = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      sections.push({ heading: line.slice(3).trim(), lines: [] })
      continue
    }
    if (line.startsWith('# ')) continue
    if (sections.length === 0) sections.push({ heading: h1, lines: [] })
    sections[sections.length - 1].lines.push(line)
  }

  const chunks: Chunk[] = []
  for (const section of sections) {
    const body = section.lines.join('\n').trim()
    if (body.length < 10) continue // 只有标题没有内容的段落不值得单独成块
    const n = String(chunks.length + 1).padStart(2, '0')
    const headingPath = section.heading === h1 ? [h1] : [h1, section.heading]
    chunks.push({
      docId: doc.id,
      chunkId: `${doc.id}#c${n}`,
      text: `${headingPath.join(' / ')}\n${body}`,
      headingPath,
      page: null,
      department: doc.department,
      updatedAt: doc.updated,
      contentHash,
    })
  }
  return chunks
}

export function loadChunks(): Chunk[] {
  return loadCorpus().flatMap(splitIntoChunks)
}
