import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Department = 'product' | 'hr' | 'eng' | 'support'

export interface Doc {
  id: string
  title: string
  department: Department
  updated: string
  /** 去掉 frontmatter 之后的正文（含 Markdown 标题） */
  body: string
}

/**
 * 语料放在 lab 根目录的 corpus/，starter 与 solution 共用同一份。
 * 这里从当前文件的位置往上两级定位，而不是用 process.cwd()——
 * 后者会随你在哪个目录敲命令而变，跑着跑着就找不到语料了。
 */
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
    .sort() // 固定顺序，保证 baseline.json 每次跑出来都一样
  const docs = files.map((f) => parseFrontmatter(readFileSync(join(CORPUS_DIR, f), 'utf8'), f))
  if (docs.length === 0) throw new Error(`语料目录是空的：${CORPUS_DIR}`)
  return docs
}

/** 检索时把标题也当作正文的一部分参与打分：标题里的词往往是最强的信号 */
export function indexableText(doc: Doc): string {
  return `${doc.title}\n${doc.body}`
}
