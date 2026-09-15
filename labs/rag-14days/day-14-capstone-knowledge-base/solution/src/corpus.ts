import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 解析（D3）+ 按标题切块（D4）+ **按租户投影**（本天新增）。
 *
 * 前两件事是从 D9 的 `corpus.ts` 原样复制过来的，切块参数逐字沿用 D7 的 `rag.config.json`，
 * 本天一个字都不改——改了就没法跟前面各天的数字比。读一遍就可以跳过。
 *
 * 本天真正新增的是最后一段：**同一份语料要投影成两个工作区的索引**。
 * 这是多租户的第一处落点：**打标发生在摄取时**，不是查询时。
 * 块 id 带上租户前缀，两个租户的块在库里是物理上不同的行——
 * 后面「跨租户泄露」才是一个能被眼睛看见的现象，而不是一个想象出来的风险。
 */

export type Department = 'product' | 'hr' | 'eng' | 'support'

/** D3 定下的块结构，全课统一，字段名不许改；本天只多加一个 tenantId */
export interface Chunk {
  tenantId: string
  docId: string
  chunkId: string
  text: string
  headingPath: string[]
  page: number | null
  department: Department
  updatedAt: string
}

/** 第一周系统的切块参数，逐字取自 D7 的 rag.config.json */
export const WEEK1_CHUNKING = { maxChars: 500, minChars: 60, overlapChars: 60 }

/** 语料在 lab 根目录，从当前文件往上两级定位；用 process.cwd() 会随你在哪敲命令而变 */
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')

export interface ParsedDoc {
  docId: string
  title: string
  department: Department
  updatedAt: string
  nodes: Array<{ headingPath: string[]; text: string }>
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

  const nodes: ParsedDoc['nodes'] = []
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

function chunkDoc(doc: ParsedDoc, tenantId: string): Chunk[] {
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
        tenantId,
        docId: doc.docId,
        // 租户前缀写进块 id：块 id 是全课的引用锚点（D6），多租户之后它必须全局唯一
        chunkId: `${tenantId}/${doc.docId}#c${String(seq).padStart(2, '0')}`,
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

export function loadDocs(): ParsedDoc[] {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
  if (files.length === 0) throw new Error(`语料目录是空的：${CORPUS_DIR}`)
  return files.map((f) => parseMarkdown(readFileSync(join(CORPUS_DIR, f), 'utf8'), f))
}

// ---------------------------------------------------------------------------
// 多租户落点之一：摄取时打标
// ---------------------------------------------------------------------------

export interface Tenant {
  id: string
  name: string
  /** 这个工作区订阅了哪些部门的文档。真实系统里它来自「这个客户上传了什么」，不是一条规则 */
  subscribes: Department[]
  /** 这个工作区内部还要按部门分权限（机制照抄 D13），列出可以细分的角色 */
  roles: Record<string, Department[]>
}

/**
 * 两个工作区。**这份语料只有一份，所以两个工作区的文档是同一批文件的两次投影**——
 * 真实系统里它们是两个客户各自上传的、毫不相干的文档。
 * 教学上这个简化不影响任何结论：租户是一个**独立的、必填的谓词**，
 * 它跟部门谓词各管各的，这一点跟文档从哪儿来无关。
 */
export const TENANTS: Tenant[] = [
  {
    id: 't-yunti',
    name: '云梯科技总部工作区',
    subscribes: ['product', 'hr', 'eng', 'support'],
    roles: {
      admin: ['product', 'hr', 'eng', 'support'],
      // 客服只看得到产品文档和工单规则——D13 那套部门过滤，本天原样复用
      support: ['product', 'support'],
    },
  },
  {
    id: 't-hexing',
    name: '合兴数科试用工作区',
    // 试用客户只导入了产品手册那一部分，人事、工程、工单文档他们那边根本没有
    subscribes: ['product'],
    roles: { admin: ['product'] },
  },
]

/**
 * 摄取：把语料按每个租户的订阅范围投影成各自的块。
 *
 * **练习 1 挖的就是这里。** 不打标（或者所有租户共用一份块）会让后面两处落点全部失效：
 * 检索时没有可过滤的字段，评估时没有可分组的键。多租户不是查询时才想起来的事。
 */
export function ingest(docs: ParsedDoc[], tenants: Tenant[]): Chunk[] {
  const chunks: Chunk[] = []
  for (const tenant of tenants) {
    for (const doc of docs) {
      if (!tenant.subscribes.includes(doc.department)) continue
      chunks.push(...chunkDoc(doc, tenant.id))
    }
  }
  return chunks
}
