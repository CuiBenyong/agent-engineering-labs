import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Department } from './types.js'

// 本文件来自 D1（labs/rag-14days/day-01-bm25-mini-rag/src/corpus.ts），本天不改。

export interface Doc {
  id: string
  title: string
  department: Department
  updated: string
  /** 去掉 frontmatter 之后的正文（含 Markdown 标题） */
  body: string
  /** 原始文件内容，算内容指纹用 */
  raw: string
}

/**
 * 语料放在 lab 根目录的 corpus/，starter 与 solution 共用同一份。
 * 从当前文件位置往上两级定位，而不是用 process.cwd()——后者会随你在哪个目录
 * 敲命令而变，跑着跑着就找不到语料了。
 */
export const LAB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORPUS_DIR = join(LAB_ROOT, 'corpus')

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
    raw,
  }
}

export function loadCorpus(): Doc[] {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort() // 固定顺序，保证每次跑出来的结果都一样
  const docs = files.map((f) => parseFrontmatter(readFileSync(join(CORPUS_DIR, f), 'utf8'), f))
  if (docs.length === 0) throw new Error(`语料目录是空的：${CORPUS_DIR}`)
  return docs
}

export function getDoc(docs: Doc[], id: string): Doc {
  const doc = docs.find((d) => d.id === id)
  if (!doc) throw new Error(`语料里没有 ${id}`)
  return doc
}
