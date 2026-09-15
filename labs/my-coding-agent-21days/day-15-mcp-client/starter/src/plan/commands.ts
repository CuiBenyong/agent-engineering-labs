/**
 * 今天新增的两条斜杠命令。本天新增。
 *
 * 单独一个文件的理由与 D12 的 context/commands.ts 一样：命令表是**数据**，
 * 按主题分文件、在总表里展开。commands.ts 已经接近本课的单文件上限。
 */
import type { Command } from '../commands.js'
import { describeMode, enterPlanMode } from './mode.js'
import { formatPlan } from './plan.js'
import { formatReconcile, reconcile } from './check.js'

export const PLAN_COMMANDS: Command[] = [
  {
    name: 'plan',
    help: '进入只读探索模式（再打一次退出）；/plan show 打印当前模式与已批准的计划',
    run: (args, session) => {
      const state = session.plan
      if (args.trim() === 'show') {
        session.out(`  当前模式：${describeMode(state)}`)
        if (state.approved) for (const row of formatPlan(state.approved)) session.out(`  ${row}`)
        for (const record of state.asked) {
          session.out(
            `  问过：${record.question} → ${record.answer.answers.join('、') || '（没答）'}`
          )
        }
        return true
      }
      if (state.mode === 'plan') {
        // 手动退出不带计划：把规则表放回去，但**什么都不授权**。
        // 「我不想按流程走了」和「我批准了这份计划」是两件事，不能共用一条路径。
        state.savedRules = state.savedRules ?? session.permissions.rules
        session.permissions.rules = state.savedRules
        state.savedRules = null
        state.mode = 'normal'
        session.out('  已退出只读探索模式（没有批准任何计划，写操作还是逐个问）')
        return true
      }
      enterPlanMode(state, session.permissions)
      session.out('  已进入只读探索模式：可以读文件、搜内容、问你一句，但改文件与跑命令都被挡着。')
      session.out('  它探清楚之后会用 submit_plan 交一份计划，你批准了才切回可写模式。')
      return true
    },
  },
  {
    name: 'check',
    help: '拿已批准的计划核对一遍实际改动（改了哪些、漏了哪些、验证跑没跑）',
    run: (_args, session) => {
      const plan = session.plan.approved
      if (!plan) {
        session.out('  还没有批准过任何计划（/plan 进探索模式，让它先出一份）')
        return true
      }
      for (const row of formatReconcile(reconcile(plan, session.plan))) session.out(`  ${row}`)
      return true
    },
  },
]
