/**
 * 阶段一的另一半：扫描目录，找出所有含 SKILL.md 的文件夹。
 *
 * 两件事最容易做错：
 *   1. 无限递归。要设深度上限，并跳过 .git、node_modules 这类不可能有 skill 的目录。
 *   2. 同名冲突静默丢弃。必须有确定的优先级，并且被遮蔽时要留一条警告。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkill, type Diagnostic, type ParsedSkill } from './parse.js'

/** 一个扫描作用域。scope 越靠前优先级越高。 */
export type Scope = { label: string; dir: string }

const MAX_DEPTH = 4
const SKIP = new Set(['.git', 'node_modules', 'dist', '.next'])

async function findSkillDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return [] // 目录不存在是正常情况：不是每个项目都有 .agents/skills
  }
  const found: string[] = []
  const hasSkillMd = entries.some((e) => e.isFile() && e.name === 'SKILL.md')
  if (hasSkillMd) return [root] // 找到一个 skill 就不再往下钻，skill 不嵌套
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue
    found.push(...(await findSkillDirs(join(root, e.name), depth + 1)))
  }
  return found
}

export type ScanResult = {
  skills: ParsedSkill[]
  diagnostics: Diagnostic[]
  /** 被同名 skill 遮蔽掉的那些，留着是为了能在诊断里说清楚 */
  shadowed: Array<{ name: string; winner: string; loser: string }>
}

/**
 * 按 scopes 的顺序扫描：先出现的作用域优先级更高，同名时后来的被遮蔽。
 * 通行约定是项目级压过用户级；具体客户端可以有自己的层级，
 * 关键是**固定一种并保持一致**，而不是每次看运气。
 */
export async function scanSkills(scopes: Scope[]): Promise<ScanResult> {
  const byName = new Map<string, ParsedSkill>()
  const diagnostics: Diagnostic[] = []
  const shadowed: ScanResult['shadowed'] = []

  for (const scope of scopes) {
    for (const dir of await findSkillDirs(scope.dir)) {
      const location = join(dir, 'SKILL.md')
      const raw = await readFile(location, 'utf8')
      const { skill, diagnostics: ds } = parseSkill(location, raw)
      diagnostics.push(...ds)
      if (!skill) continue
      const existing = byName.get(skill.name)
      if (existing) {
        // 先来的作用域优先级更高，所以保留 existing，把这一个记成被遮蔽
        shadowed.push({ name: skill.name, winner: existing.location, loser: skill.location })
        diagnostics.push({
          level: 'warn',
          skillPath: skill.location,
          message: `被同名 skill 遮蔽，生效的是 ${existing.location}`,
        })
        continue
      }
      byName.set(skill.name, skill)
    }
  }

  return { skills: [...byName.values()], diagnostics, shadowed }
}
