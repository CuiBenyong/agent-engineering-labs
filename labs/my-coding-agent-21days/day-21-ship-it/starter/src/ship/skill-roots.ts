/**
 * 技能从哪儿找。本天新增。
 *
 * 第十六天的加载器只认一个目录：跟 src/ 平级的 skills/。那是**随包分发**的那一批，
 * 全局安装之后它跟着包跑到 npm 前缀里去了——正确，但不够：用户还需要一个地方
 * 放自己仓库的约定，而那个地方显然不在别人的包里。
 *
 * 三个来源，与配置分层同一套语义（作用范围越窄优先级越高）：
 *   包内 skills/            随 mca 分发的示例与通用技能
 *   ~/.mca/skills/          这台机器上我个人的
 *   <项目>/.mca/skills/     这个仓库的团队约定（进 git）
 *
 * 同名（同目录名）时**离项目最近的赢**，并且要在 problems 里说一句谁盖了谁——
 * 静默覆盖是技能系统里第二难查的故障（第一难查的是漏触发）。
 */
import path from 'node:path'
import { scanSkills, SKILLS_DIR, type ScanResult } from '../skills/scan.js'
import { projectConfigDir, userConfigDir } from './paths.js'

export interface SkillRoot {
  label: string
  dir: string
}

export function skillRoots(): SkillRoot[] {
  return [
    { label: '包内', dir: SKILLS_DIR },
    { label: '用户', dir: path.join(userConfigDir(), 'skills') },
    { label: '项目', dir: path.join(projectConfigDir(), 'skills') },
  ]
}

export async function scanAllSkills(roots: SkillRoot[] = skillRoots()): Promise<ScanResult> {
  const byId = new Map<string, { root: SkillRoot; skill: ScanResult['skills'][number] }>()
  const problems: string[] = []
  for (const root of roots) {
    const scanned = await scanSkills(root.dir)
    for (const problem of scanned.problems) problems.push(`[${root.label}] ${problem}`)
    for (const skill of scanned.skills) {
      const previous = byId.get(skill.id)
      if (previous) {
        problems.push(
          `${skill.id} 同时存在于${previous.root.label}与${root.label}，用的是${root.label}那一份`
        )
      }
      byId.set(skill.id, { root, skill })
    }
  }
  return { skills: [...byId.values()].map((entry) => entry.skill), problems }
}
