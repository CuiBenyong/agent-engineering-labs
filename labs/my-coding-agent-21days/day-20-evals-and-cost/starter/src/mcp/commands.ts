/**
 * 本天新增的一条斜杠命令：/mcp。
 *
 * 它只做一件事——**把「工具从哪儿来」摆到明面上**。
 *
 * 这不是可有可无的调试功能。工具清单一旦混进别人的东西，用户就有权知道
 * 哪个工具会把他的代码片段发到哪个进程、哪个地址去。掉线的 server 也在这里列出来：
 * **静默降级比掉线更糟**，模型会表现得像那个能力从来不存在。
 */
import type { Command } from '../commands.js'
import { mcpEnabled, ticketsUrl } from './servers.js'

export const MCP_COMMANDS: Command[] = [
  {
    name: 'mcp',
    help: '列出挂载的 MCP server、它们的工具与来源',
    run: (_args, session) => {
      if (!mcpEnabled()) {
        session.out('  MCP 已关闭（MCP=off）。当前只有 mca 自己的本地工具。')
        return true
      }
      const mount = session.mcp
      if (!mount) {
        session.out('  这个会话没有挂载任何 MCP server。')
        return true
      }
      const rows = mount.report()
      if (rows.length === 0) session.out('  一个远端工具都没有挂上。')
      for (const row of rows) session.out(row)
      session.out(`  工单系统的地址：${ticketsUrl()}`)
      session.out(
        '  远端工具一律按「会改东西」对待，每次调用都要过审批门——' +
          '服务端自己声明的 readOnlyHint 不作数。'
      )
      return true
    },
  },
]
