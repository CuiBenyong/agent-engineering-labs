/**
 * 阶段二：激活。只把**被选中的那一个** skill 的正文放进上下文，
 * 用结构化标签包起来，并把技能目录与附带资源一并告诉模型（但不预读它们）。
 *
 * 三条纪律：
 *   1. 同一个 skill 重复激活要去重，否则同一段指令会在上下文里出现好几遍。
 *   2. 激活出来的这条消息要标成「受保护」，压缩时不能把它丢掉 ——
 *      丢了不会报错，只会让模型悄悄退回没有这个 skill 的行为。
 *   3. 资源只列出文件名，不读内容。那是阶段三的事。
 */
import { readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { ParsedSkill } from './parse.js'

export type Message = {
  role: 'user' | 'assistant'
  content: string
  protectedFromCompaction?: boolean
}

async function listResources(skillDir: string): Promise<string[]> {
  const out: string[] = []
  for (const sub of ['scripts', 'references', 'assets']) {
    let entries
    try {
      entries = await readdir(join(skillDir, sub), { withFileTypes: true, recursive: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile())
        out.push(relative(skillDir, join(e.parentPath ?? join(skillDir, sub), e.name)))
    }
  }
  return out.sort()
}

export async function activate(
  messages: Message[],
  skill: ParsedSkill,
  activated: Set<string>
): Promise<{ injected: boolean; tokens: number }> {
  if (activated.has(skill.name)) return { injected: false, tokens: 0 } // 去重

  const skillDir = dirname(skill.location)
  const resources = await listResources(skillDir)
  const content = [
    `<skill_content name="${skill.name}">`,
    skill.body,
    '',
    `技能目录：${skillDir}`,
    '本技能里的相对路径按该目录解析。',
    resources.length > 0
      ? `<skill_resources>\n${resources.map((r) => `  <file>${r}</file>`).join('\n')}\n</skill_resources>`
      : '<skill_resources />',
    '</skill_content>',
  ].join('\n')

  messages.push({ role: 'user', content, protectedFromCompaction: true })
  activated.add(skill.name)
  return { injected: true, tokens: Math.ceil(content.length / 2.5) }
}
