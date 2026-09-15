/**
 * 本天新增的一条斜杠命令：/agents。
 *
 * 它不是调试功能。子 Agent 是**你看不见的那部分花费**：主会话的终端上只会滚过
 * 一行「已派出 2 个子 Agent」，而背后可能是两倍甚至四倍的 token。
 * 把上一次派发的账摊开，用户才判断得出这活儿值不值得并行。
 */
import type { Command } from '../commands.js'
import { getLastDispatch } from './tool.js'
import { AGENTS_DIR, listWorktrees } from './worktree.js'
import { MAX_AGENTS, SUBAGENT_LIMITS } from './spec.js'

export const AGENT_COMMANDS: Command[] = [
  {
    name: 'agents',
    help: '看上一次派发的账：每个子 Agent 花了多少、合并怎么裁的、并行省下多少',
    run: async (_args, session) => {
      session.out(`  工位开在 ${AGENTS_DIR}，一次最多 ${MAX_AGENTS} 个`)
      session.out(
        `  子 Agent 的独立预算：${SUBAGENT_LIMITS.maxRounds} 圈 / ` +
          `${(SUBAGENT_LIMITS.maxMs ?? 0) / 1000} 秒 / ${SUBAGENT_LIMITS.maxTokens} token`
      )
      const left = await listWorktrees()
      session.out(left.length > 0 ? `  ⚠ 还有没收的工位：${left.join('、')}` : '  工位已收干净')

      const last = getLastDispatch()
      if (!last) {
        session.out('  这个会话还没派过子 Agent')
        return true
      }
      const serialMs = last.results.reduce((sum, r) => sum + r.ms, 0)
      const tokens = last.results.reduce((sum, r) => sum + r.tokens, 0)
      for (const result of last.results) {
        session.out(
          `  ${result.id}  ${result.ok ? '完成' : '未完成'}  ` +
            `${result.rounds} 次工具调用 / 约 ${result.tokens} token / ${result.ms}ms  ` +
            `改了 ${result.changes.length} 个文件`
        )
      }
      session.out(
        `  并行墙上时间 ${last.wallMs}ms，串行相加是 ${serialMs}ms；` +
          `这些 token（约 ${tokens}）主会话一个都没看到，但你一样要付`
      )
      for (const entry of last.plan.entries) session.out(`  ${entry.path} → ${entry.why}`)
      return true
    },
  },
]
