import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Department } from './chunk.js'

// 本文件来自 D1 / D3（labs/rag-14days/day-01-bm25-mini-rag/solution/src/corpus.ts），本天不改。

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
 * 从当前文件位置往上两级定位，而不是用 process.cwd()——后者会随你在哪个目录敲命令而变。
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

// ---------------------------------------------------------------------------
// 第二次同步的来源快照
// ---------------------------------------------------------------------------

/**
 * 造一份「第二天的来源」：真实系统里这是网盘、Confluence、工单系统再拉一遍的结果。
 * 语料目录本身**一个字都不改**（那是全课共用的原件），变更全部在内存里造。
 *
 * 五种变更各造一例，正好覆盖增量同步要处理的全部情况：
 *
 *   修改   doc-006  正文里的一个数字改了
 *   新增   doc-031  新写的一篇发布说明
 *   删除   doc-030  从来源里消失了
 *   重传   doc-005  内容一字未改，但换行符变成了 Windows 的 \r\n
 *   重复   doc-032  和 doc-031 内容完全相同（同一份文件被人另存了一份）
 */
export interface Snapshot {
  docs: Doc[]
  /** 便于打印说明 */
  notes: string[]
}

const NEW_DOC_BODY = `# 云梯协作 3.4 发布说明

## 本次变更

任务板新增了泳道折叠，长期项目的看板不用再一直往下滚。
导出功能支持按泳道拆成多个文件，方便分包交付。

## 已知问题

移动端在泳道折叠状态下拖拽卡片偶尔会掉回原位，修复排期在 3.4.1。`

function makeDoc(id: string, title: string, department: Department, updated: string, body: string) {
  const raw = `---\nid: ${id}\ntitle: ${title}\ndepartment: ${department}\nupdated: ${updated}\n---\n\n${body}\n`
  return { id, title, department, updated, body, raw }
}

export function buildSnapshot(base: Doc[]): Snapshot {
  const docs: Doc[] = []
  const notes: string[] = []

  for (const doc of base) {
    if (doc.id === 'doc-030') {
      notes.push('删除：doc-030 从来源里消失了')
      continue
    }
    if (doc.id === 'doc-006') {
      // 改一个数字：单文件上限从 200 MB 调到 500 MB
      const body = doc.body.replace('200 MB', '500 MB')
      const raw = doc.raw.replace('200 MB', '500 MB')
      notes.push('修改：doc-006 的单文件上限 200 MB 改成 500 MB')
      docs.push({ ...doc, body, raw, updated: '2026-09-01' })
      continue
    }
    if (doc.id === 'doc-005') {
      // 一字未改，只是换行符从 \n 变成 \r\n——跨系统重传的典型形态
      notes.push('重传：doc-005 内容一字未改，换行符变成了 \\r\\n')
      docs.push({ ...doc, raw: doc.raw.replace(/\n/g, '\r\n') })
      continue
    }
    docs.push(doc)
  }

  const added = makeDoc('doc-031', '云梯协作 3.4 发布说明', 'product', '2026-09-02', NEW_DOC_BODY)
  const duplicated = makeDoc(
    'doc-032',
    '云梯协作 3.4 发布说明',
    'product',
    '2026-09-02',
    NEW_DOC_BODY
  )
  // 两篇的 raw 里 id 那一行不同，指纹会不一样——生产上重复文件通常是「正文相同、文件名不同」，
  // 所以指纹要算在**正文**上，不能把来源路径、文件名这类元信息也拌进去。
  duplicated.raw = added.raw.replace('id: doc-031', 'id: doc-032')
  notes.push('新增：doc-031 是新写的发布说明')
  notes.push('重复：doc-032 与 doc-031 正文完全相同（同一份文件被另存了一份）')
  docs.push(added, duplicated)

  return { docs: docs.sort((a, b) => a.id.localeCompare(b.id)), notes }
}
