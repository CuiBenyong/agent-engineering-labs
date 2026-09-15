/**
 * 把引用展开成注入内容。本天新增。
 *
 * 三类来源、三种展开方式，每一种都有一条今天定下的口径：
 *
 *   文件  →  带行号的正文，**格式和 read_file 的输出一模一样**。
 *            理由：模型不该学两种「文件长什么样」的格式。它看到行号就会用行号说话，
 *            而 edit_file 与 read_file 也在用同一套行号。
 *   目录  →  **只给文件树，不给内容**。目录是「范围」不是「材料」：告诉它有哪些文件，
 *            它自己会挑要读的那一两个。把一个目录的内容全塞进去，是把预算换成了噪音。
 *   网址  →  抓取后抽正文（见 web.ts）。
 *
 * 通配符（`@src/**` 这种）单独算一类形态：它会展开成很多个文件来源，
 * 这些来源被标成二级（derived）——用户没有逐个点名它们，所以预算不够时先丢它们。
 *
 * 还有一条安全不变量，和第三天的工具一致：**解析出来的绝对路径必须落在给定的根里面。**
 * 引用是用户手打的，`@../../etc/passwd` 一定会有人试。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { globToRegExp, resolveInside, walkFiles } from '../tools/fs.js'
import type { Reference } from './parse.js'
import type { Source } from './budget.js'
import { fetchPage } from './web.js'

/** 超过这个字节数就拒绝，而不是截断。拒绝比截断诚实：见文件末尾的说明 */
export const MAX_FILE_BYTES = 200_000
/** 一个通配符最多展开出多少个文件来源 */
export const MAX_GLOB_SOURCES = 12
/** 一个目录树最多列多少条 */
export const MAX_TREE_ENTRIES = 200

export interface Root {
  /** 显示给用户的名字，例如 work/repo */
  name: string
  dir: string
}

export interface ExpandOptions {
  roots: Root[]
  signal?: AbortSignal
}

export async function expandReferences(
  refs: Reference[],
  options: ExpandOptions
): Promise<Source[]> {
  const sources: Source[] = []
  for (const ref of refs) {
    if (ref.kind === 'url') {
      sources.push(await expandUrl(ref, options))
      continue
    }
    if (ref.kind === 'glob') {
      sources.push(...(await expandGlob(ref, options)))
      continue
    }
    sources.push(await expandPath(ref, options))
  }
  return sources
}

async function expandUrl(ref: Reference, options: ExpandOptions): Promise<Source> {
  const page = await fetchPage(ref.target, options.signal)
  if (!page.ok) return { label: ref.target, tier: 'named', content: '', problem: page.problem }
  return {
    label: ref.target,
    tier: 'named',
    content: `网页：${page.title}\n来源：${ref.target}\n\n${page.text}`,
  }
}

/** 在多个根里找同一个相对路径。找到第一个就用它，并记下是哪个根 */
async function locate(
  target: string,
  roots: Root[]
): Promise<{ root: Root; absolute: string; isDir: boolean } | null> {
  for (const root of roots) {
    let absolute: string
    try {
      absolute = resolveInside(root.dir, target)
    } catch {
      continue // 跑出这个根就换下一个根试；全都跑出去就是找不到
    }
    try {
      const stat = await fs.stat(absolute)
      return { root, absolute, isDir: stat.isDirectory() }
    } catch {
      continue
    }
  }
  return null
}

async function expandPath(ref: Reference, options: ExpandOptions): Promise<Source> {
  const found = await locate(ref.target.replace(/\/+$/, ''), options.roots)
  if (!found) {
    const where = options.roots.map((r) => r.name).join(' 或 ')
    return {
      label: ref.target,
      tier: 'named',
      // 人话提示要带上「我在哪儿找过」，否则用户只能猜自己写错了什么
      problem: `找不到（在 ${where} 里都没有这个路径）`,
      content: '',
    }
  }
  if (found.isDir) return readTree(ref.target, found.root, found.absolute)
  return readTextFile(ref.target, found.root, found.absolute, 'named')
}

async function expandGlob(ref: Reference, options: ExpandOptions): Promise<Source[]> {
  const matcher = globToRegExp(ref.target)
  for (const root of options.roots) {
    const all = await walkFiles(root.dir)
    const matched = all.filter((rel) => matcher.test(rel))
    if (matched.length === 0) continue
    const shown = matched.slice(0, MAX_GLOB_SOURCES)
    const sources = await Promise.all(
      // 通配符展开出来的是二级来源：用户点的是一个模式，不是这些具体文件
      shown.map((rel) => readTextFile(rel, root, path.join(root.dir, rel), 'derived'))
    )
    if (matched.length > shown.length) {
      sources.push({
        label: ref.target,
        tier: 'named',
        content: '',
        problem: `匹配到 ${matched.length} 个文件，只注入了前 ${shown.length} 个（把模式写窄一点）`,
      })
    }
    return sources
  }
  return [
    {
      label: ref.target,
      tier: 'named',
      content: '',
      problem: '这个通配符没有匹配到任何文件',
    },
  ]
}

/**
 * 文件正文。三道检查的顺序是有讲究的：先看大小（不用读整个文件），
 * 再读字节看有没有空字节（判二进制），最后才转成文本。
 * 倒过来写的话，一个两百兆的视频会先被完整读进内存。
 */
async function readTextFile(
  label: string,
  root: Root,
  absolute: string,
  tier: Source['tier']
): Promise<Source> {
  const stat = await fs.stat(absolute).catch(() => null)
  if (!stat) return { label, tier, content: '', problem: '读不到这个文件' }

  if (stat.size > MAX_FILE_BYTES) {
    return {
      label,
      tier,
      content: '',
      // 拒绝而不是截断：见本文件末尾
      problem:
        `太大了（${Math.round(stat.size / 1024)} KB，上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB），没有注入。` +
        '请用 read_file 带 offset 分段读，或者只引用其中一段',
    }
  }

  const raw = await fs.readFile(absolute)
  if (raw.includes(0)) {
    return {
      label,
      tier,
      content: '',
      problem: `看起来是二进制文件（${raw.length} 字节），没有注入`,
    }
  }

  const lines = raw.toString('utf8').split('\n')
  // 行号格式与 read_file 完全一致：模型不该学两种「文件长什么样」
  const numbered = lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
  return {
    label,
    tier,
    content: `${label}（共 ${lines.length} 行，相对 ${root.name}）\n${numbered}`,
  }
}

async function readTree(label: string, root: Root, absolute: string): Promise<Source> {
  const files = await walkFiles(absolute)
  if (files.length === 0) {
    return { label, tier: 'named', content: '', problem: '这个目录里没有文件' }
  }
  const shown = files.slice(0, MAX_TREE_ENTRIES)
  const rest = files.length - shown.length
  const tail = rest > 0 ? `\n…（还有 ${rest} 个文件没列出）` : ''
  return {
    label,
    tier: 'named',
    // 只有树，没有内容：目录是范围不是材料
    content:
      `目录 ${label}（${files.length} 个文件，相对 ${root.name}）\n` +
      `${shown.map((rel) => `  ${rel}`).join('\n')}${tail}\n` +
      '（这是文件清单，不是内容。需要看某个文件就用 read_file。）',
  }
}

/**
 * 为什么超大文件是「拒绝」而不是「截断」：
 *
 * 截断一个日志文件，模型拿到的是首尾各一段，中间那句关键报错正好在被截掉的地方——
 * 而它**看不出来自己被骗了**，会基于不完整的材料给出很自信的结论。
 * 拒绝并给出下一步（用 read_file 带 offset 分段读、或者只引用其中一段），
 * 反而让它有机会拿到真正需要的那一段。
 *
 * 那单源上限那里为什么又允许截断？因为那是**已经通过大小检查**的文件，
 * 量级是可控的（预算的一半），而且截断处会明确写「中间截掉了多少、怎么补读」。
 * 两种处理的分界线是「差一点」还是「差一个数量级」。
 */
