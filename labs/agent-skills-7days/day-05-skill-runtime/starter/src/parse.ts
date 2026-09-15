/**
 * 阶段一的一半：把一个 SKILL.md 解析成「元数据 + 正文」。
 *
 * 这里刻意用**宽松校验**：别人写的 skill 不合规范时，能加载就加载，只记一条诊断。
 * 唯一会导致跳过的是「没有 description」——缺了它，这个 skill 在发现阶段就没有触发面，
 * 留着也永远不会被选中，反而白占目录的 token。
 */
import { basename, dirname } from 'node:path'

export type Diagnostic = { level: 'warn' | 'error'; skillPath: string; message: string }

export type ParsedSkill = {
  name: string
  description: string
  /** SKILL.md 的绝对或相对路径。技能目录 = 它的父目录，用来解析相对引用 */
  location: string
  body: string
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 分离 frontmatter 与正文。返回 null 表示连 frontmatter 都没有。 */
export function splitFrontmatter(raw: string): { front: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  return m ? { front: m[1], body: m[2].trim() } : null
}

/**
 * 取一个标量字段的值。这里没有用完整的 YAML 解析器，是有意的：
 * 真实实现应当先用 YAML 解析，失败时再退回这种「按行取值」的兜底，
 * 因为最常见的畸形是值里有没加引号的冒号，正规解析器会直接拒绝整个文件。
 */
function readField(front: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)
  if (!m) return undefined
  return m[1].trim().replace(/^["']|["']$/g, '')
}

export function parseSkill(
  location: string,
  raw: string
): { skill: ParsedSkill | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const parts = splitFrontmatter(raw)
  if (!parts) {
    diagnostics.push({ level: 'error', skillPath: location, message: '没有 frontmatter，跳过' })
    return { skill: null, diagnostics }
  }

  const dir = basename(dirname(location))
  const name = readField(parts.front, 'name') ?? dir
  const description = readField(parts.front, 'description')

  // 练习 3：宽松校验。规则是「能加载就加载，只记诊断」，只有一种情况例外。
  //   - 没有 description  → 直接跳过（返回 skill: null），因为它在发现阶段没有触发面
  //   - name 与目录名不一致 → 只 warn，仍然加载
  //   - name 超过 64 字符 / 不符合命名规则 → 只 warn，仍然加载
  //   - description 超过 1024 字符 → 只 warn，仍然加载
  // 现在什么都不校验，缺 description 的 skill 也会被放进目录 —— 自检会抓到这一条。
  return {
    skill: { name, description: description ?? '', location, body: parts.body },
    diagnostics,
  }
}
