/**
 * 今天新增的三条斜杠命令。本天新增。
 *
 * 为什么单独一个文件而不是直接加进 commands.ts：那个文件已经 273 行，
 * 而本课的单文件上限是 350。命令表本来就是**数据**，数据按主题分文件、
 * 在总表里展开一下即可——D6 把命令从 repl.ts 搬出来时定的就是这条规矩，
 * 今天只是把它再往下分了一层。第九天起要加命令，照这个形状再加一个文件。
 */
import type { Command } from '../commands.js'
import { createProvider } from '../providers/index.js'
import { accountLanes, formatBudget } from './budget.js'
import { checkProbes, compact, decideCompaction, type Probe } from './compact.js'
import { activeCoefficients, applyCalibration, estimateMessages } from './tokens.js'

/**
 * 手动压缩时用的探针。它们是**当前会话的**早期事实，本来该由用户自己给；
 * 这里放两条默认的，好让 `/compact` 在实验里直接看到「压完还答得上来吗」这一步。
 */
const DEFAULT_PROBES: Probe[] = [
  { question: '这个仓库的构建命令是什么？', expect: 'pnpm build:calc' },
  { question: '失败的那个用例是哪一个？', expect: 'divide by zero' },
]

export const CONTEXT_COMMANDS: Command[] = [
  {
    name: 'budget',
    help: '按路打印上下文预算的占用（系统指令 / 指令文件 / 记忆 / 引用 / 摘要 / 对话 / 工具结果）',
    run: (_args, session) => {
      for (const row of formatBudget(accountLanes(session.messages))) session.out(row)
      const decision = decideCompaction(session.messages)
      session.out(`  ${decision.reason}`)
      return true
    },
  },
  {
    name: 'tokens',
    help: '显示 token 估算系数与校准状态（/tokens 会用已收集的真实用量重新校准一次）',
    run: (_args, session) => {
      const coeff = activeCoefficients()
      session.out(
        `  当前系数：中日韩 ${coeff.cjk.toFixed(2)} token/字，其余 ${coeff.rest.toFixed(2)} token/字符`
      )
      session.out(
        `  当前上下文估算 ${estimateMessages(session.messages)} token（${session.messages.length} 条消息）`
      )
      const rows = applyCalibration(session.calibrator)
      if (rows.length === 0) {
        session.out(`  真实用量样本 ${session.calibrator.size} 条，至少要 3 条才能校准`)
      }
      for (const row of rows) session.out(`  ${row}`)
      session.out('  精确计数要靠模型自己的分词器，这里是估算——两者的用途见第十二天正文')
      return true
    },
  },
  {
    name: 'compact',
    help: '立刻压缩一次上下文（不等触发线），并用探针检查早期事实还在不在',
    run: async (_args, session) => {
      const before = session.messages.length
      const result = await compact(createProvider(), session.messages)
      for (const row of result.report) session.out(row)
      if (!result.compacted) return true
      for (const probe of checkProbes(session.messages, DEFAULT_PROBES)) {
        session.out(`  ${probe.found ? '✔' : '✘'} 探针「${probe.question}」→ ${probe.expect}`)
      }
      session.out(`  （${before} 条 → ${session.messages.length} 条；/log 可以看压缩前的原始事件）`)
      return true
    },
  },
]
