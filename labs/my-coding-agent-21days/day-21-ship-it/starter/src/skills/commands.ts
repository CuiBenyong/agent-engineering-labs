/**
 * 本天新增的两条斜杠命令：/skills 与 /skill。
 *
 * /skills 把三个阶段的账摊开：装了哪些、哪些没装上、阶段一花了多少、
 * 全量加载要花多少。**这不是调试功能**——技能是一段会悄悄影响模型行为的文字，
 * 用户有权知道此刻有哪几段在场、又有哪几段因为写坏了根本没在场。
 *
 * /skill <id> 是「用户显式点名」那一支：有些技能的触发词天然写不准
 * （比如一份「怎么写提交信息」的规范），漏触发时用户需要一个手动开关。
 * 点名只对接下来那一轮有效，用完就清——常驻的东西已经有阶段一了。
 */
import type { Command } from '../commands.js'
import { stage1Summary, fullLoadCost, SKILL_BODY_BUDGET } from './inject.js'

export const SKILL_COMMANDS: Command[] = [
  {
    name: 'skills',
    help: '列出装上的技能、没装上的问题，以及三个阶段各花多少 token',
    run: async (_args, session) => {
      const { skills, problems, pinned } = session.skills
      if (skills.length === 0) session.out('  一个技能都没装（skills/ 目录是空的或不存在）')
      for (const skill of skills) {
        const mark = pinned.includes(skill.id) ? '📌' : '  '
        session.out(`${mark}${skill.id}  领域 ${skill.domain}  全文 ${skill.bodyChars} 字符`)
        session.out(`    触发词 ${skill.triggers.join('、') || '（无）'}`)
        session.out(`    路径 ${skill.paths.join('、') || '（无）'}`)
        for (const attachment of skill.attachments) {
          session.out(`    附件 node ${attachment.runPath} —— ${attachment.note}`)
        }
      }
      for (const problem of problems) session.out(`  ⚠ 没装上：${problem}`)
      const stage1 = stage1Summary(skills)
      const full = await fullLoadCost(skills)
      session.out(
        `  阶段一常驻：${stage1.chars} 字符 / 约 ${stage1.tokens} token（每一次请求都带着）`
      )
      session.out(
        `  全量加载要：${full.chars} 字符 / 约 ${full.tokens} token（作为对照，我们没有这么做）`
      )
      session.out(`  阶段二预算：${SKILL_BODY_BUDGET} 字符，按命中分数从高到低装，同领域只装一条`)
      return true
    },
  },
  {
    name: 'skill',
    help: '显式点名一个技能，让它在下一轮强制展开全文（/skill 不带参数取消点名）',
    run: (args, session) => {
      const id = args.trim()
      if (!id) {
        session.skills.pinned = []
        session.out('  已取消所有点名，触发判定回到自动模式')
        return true
      }
      if (!session.skills.skills.some((skill) => skill.id === id)) {
        session.out(`  没有装上名为 ${id} 的技能（/skills 看有哪些）`)
        return true
      }
      if (!session.skills.pinned.includes(id)) session.skills.pinned.push(id)
      session.out(`  已点名 ${id}，下一轮会强制展开它的全文`)
      return true
    },
  },
]
