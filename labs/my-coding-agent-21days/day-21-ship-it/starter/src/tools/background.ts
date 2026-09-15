/**
 * run_background：把一条命令扔到后台。本天新增。
 *
 * 它需要一个外部能力（任务表），所以按第十三天定下的规矩**用工厂函数注入依赖**——
 * ToolContext 与 AgentEvent 一个字段都没加。第十五天的 MCP 工具、第十六天的技能
 * 都是这么接进来的，今天是第三次。
 *
 * 描述里那两句「立刻返回，不是执行结果」是**必须写的**，不是客套：
 * 模型见过的绝大多数工具都是「调用完就拿到答案」，一个返回受理回执的工具
 * 不明说的话，它会把回执当成结果，然后信心十足地告诉用户「测试已经跑完了」。
 */
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import type { TaskManager } from '../tasks/manager.js'

export function createBackgroundTool(manager: TaskManager): ToolDef {
  return {
    name: 'run_background',
    description:
      '把一条耗时很久的命令放到后台执行，立刻返回一个任务号。' +
      '**返回的是受理回执，不是执行结果**：命令这时候才刚开始跑。' +
      '任务结束时系统会把结果告诉你，在那之前不要假设它已经完成。' +
      '短命令（几秒内能跑完的）请继续用 run_command，后台任务查起来更麻烦。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要在后台执行的命令' },
        why: { type: 'string', description: '一句话说明为什么它该放到后台' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    // 它会执行任意命令，当然不是只读的：审批门（D5）照样拦它
    readOnly: false,

    async run(rawArgs: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const command = String(args.command ?? '').trim()
      if (!command) return { ok: false, content: 'command 是空的，没有起任何任务。' }
      const task = manager.start(command)
      return {
        ok: true,
        content:
          `已经把这条命令放到后台，任务号 ${task.id}：${command}。` +
          `它现在才刚开始跑，还没有任何结果。完成时系统会把退出码告诉你，` +
          `在那之前请继续做别的事，不要凭空断定它成功了。`,
        meta: { taskId: task.id, logPath: task.logPath },
      }
    },
  }
}
