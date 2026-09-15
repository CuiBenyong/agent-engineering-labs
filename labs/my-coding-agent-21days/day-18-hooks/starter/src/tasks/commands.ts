/**
 * 后台任务的两条斜杠命令：/bg 与 /tasks。本天新增。
 *
 * 两条对应三件套里的后两件（进程那件由模型或用户发起）：**查得到、看得见日志。**
 * 少了它们，一个后台任务就是一个启动完就再也找不到的东西——而「找不到」在用户那里
 * 表现成「它好像没干活」，那是最让人不信任这个工具的一种故障。
 */
import type { Command } from '../commands.js'

export const TASK_COMMANDS: Command[] = [
  {
    name: 'bg',
    help: '把一条命令放到后台跑：/bg node --test',
    run: (args, session) => {
      const command = args.trim()
      if (!command) {
        session.out('  用法：/bg node ../../src/tasks/worker.mjs')
        return true
      }
      const task = session.tasks.manager.start(command)
      session.out(`  已受理 ${task.id}：${command}（还没有结果，完成时会通知你）`)
      return true
    },
  },
  {
    name: 'tasks',
    help: '列出后台任务；带任务号就看它的日志尾巴：/tasks t1',
    run: async (args, session) => {
      const id = args.trim()
      if (id) {
        const task = session.tasks.manager.get(id)
        if (!task) {
          session.out(`  没有编号为 ${id} 的任务（/tasks 看有哪些）`)
          return true
        }
        session.out(`  ${task.id}  ${task.status}  ${task.command}`)
        session.out(`  日志 ${task.logPath}`)
        for (const line of await session.tasks.manager.tail(id)) session.out(`    ${line}`)
        return true
      }
      const all = session.tasks.manager.list()
      if (all.length === 0) session.out('  还没有任何后台任务（/bg 起一个）')
      for (const task of all) {
        const p = task.progress
        const cost = task.status === 'running' ? '进行中' : `${task.ms}ms`
        const done = p ? `  进度 ${p.step}/${p.total} ${p.note}` : ''
        session.out(`  ${task.id}  ${task.status}  ${cost}  ${task.command}${done}`)
      }
      return true
    },
  },
]
