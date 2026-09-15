// 笔记库的读取层：把 ../../notes 下的 Markdown 扫成内存里的一张表。
// 这里刻意不引 gray-matter 之类的库——frontmatter 只有三个字段，手写十几行更好读，
// 也让读者看清「资源」这层抽象底下其实什么都没有，就是一堆文件。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 笔记库在 lab 根目录，starter 与 solution 共用同一份数据 */
export const NOTES_DIR = path.resolve(fileURLToPath(import.meta.url), '../../../notes')

/** 资源 URI 的自定义 scheme。自定义 scheme 必须符合 RFC 3986，这里是 notes:///<slug> */
export const URI_SCHEME = 'notes'

export interface Note {
  /** 文件名去掉 .md，同时也是 URI 的最后一段 */
  slug: string
  title: string
  tags: string[]
  updated: string
  body: string
}

/** notes:///<slug> —— 单篇笔记的规范 URI */
export function noteUri(slug: string): string {
  return `${URI_SCHEME}:///${slug}`
}

/**
 * 从 URI 反解出 slug，顺便做安全校验。
 * 规范要求服务端 MUST 校验资源 URI、MUST 清洗路径以防目录穿越——
 * 这一步就是那条要求的落点，不做的话 notes:///../../etc/passwd 会直接读到库外。
 */
export function slugFromUri(uri: string): string | null {
  if (!uri.startsWith(`${URI_SCHEME}:///`)) return null
  const slug = decodeURIComponent(uri.slice(`${URI_SCHEME}:///`.length))
  // 只放行安全字符集，顺带把 .. 和分隔符一起挡在门外
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null
  return slug
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of raw.slice(4, end).split('\n')) {
    const at = line.indexOf(':')
    if (at === -1) continue
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n/, '') }
}

function parseTags(value: string | undefined): string[] {
  if (!value) return []
  // frontmatter 里写的是 [mcp, basics] 这种行内数组
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * 扫描整个笔记库并按 slug 排序返回。
 * 排序不是洁癖：规范建议列表返回确定性顺序，客户端才敢缓存，
 * 而分页游标编的是偏移量，顺序一变游标就会串页。
 */
export async function scanNotes(): Promise<Note[]> {
  const entries = await fs.readdir(NOTES_DIR)
  const notes: Note[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue
    const raw = await fs.readFile(path.join(NOTES_DIR, entry), 'utf8')
    const { meta, body } = parseFrontmatter(raw)
    const slug = entry.slice(0, -3)
    notes.push({
      slug,
      title: meta.title ?? slug,
      tags: parseTags(meta.tags),
      updated: meta.updated ?? '',
      body,
    })
  }
  return notes
}

export async function notesByTag(tag: string): Promise<Note[]> {
  const all = await scanNotes()
  const wanted = tag.toLowerCase()
  return all.filter((n) => n.tags.some((t) => t.toLowerCase() === wanted))
}
