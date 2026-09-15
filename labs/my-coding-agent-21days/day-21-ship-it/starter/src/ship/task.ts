/**
 * 一次性任务模式 `mca --task "..."`。本天新增。
 *
 * 为什么到了发布这一天才做这件事：前二十天 mca 只有 REPL 一种形态，而 REPL
 * 是给人用的。装到别人机器上之后，它立刻会被塞进人以外的地方——Makefile、
 * CI、git hook、另一个脚本。那些地方没有 tty，**REPL 在无交互终端下
 * stdin 立刻 EOF**，打印一行提示就退出、退出码还是 0（这正是本课验收纪律
 * 从第一天就在防的那件事）。
 *
 * 非交互形态有一条自己的纪律：**审批的默认答案必须是拒绝。**
 * 交互模式里「不回答」只是用户在犹豫；非交互模式里「不回答」是常态，
 * 把它当成同意，等于给所有 CI 发了一张无限授权。所以要动东西必须显式 --yes，
 * 而且被挡下时要把这句话说给模型听，让它改走只读的路而不是原地重试。
 */
import { stdout } from 'node:process'
import { createProvider } from '../providers/index.js'
import { seedRepo } from '../seed.js'
import { SessionLog } from '../session/log.js'
import { CheckpointLog } from '../snapshot/log.js'
import { newSession } from '../session-factory.js'
import { runTurn } from '../turn.js'
import type { ApprovalAnswer, ApprovalRequest } from '../kernel/approval.js'
import { scanAllSkills } from './skill-roots.js'

export interface TaskOptions {
  line: string
  /** 显式授权写操作。不给就是只读跑一趟 */
  yes: boolean
  write?: (chunk: string) => void
}

export interface TaskOutcome {
  /** 进程退出码：出错或被拒到干不下去时非 0 */
  code: number
  tools: string[]
  text: string
  blocked: number
}

export async function runTask(options: TaskOptions): Promise<TaskOutcome> {
  const write = options.write ?? ((chunk: string) => void stdout.write(chunk))
  const out = (line: string) => write(`${line}\n`)
  const provider = createProvider()
  await seedRepo()
  const checkpoints = await CheckpointLog.open()
  const scanned = await scanAllSkills()
  for (const problem of scanned.problems) out(`[skills] ⚠ ${problem}`)
  const session = newSession(out, await SessionLog.create(), {
    checkpoints,
    skills: { ...scanned, pinned: [] },
  })

  let blocked = 0
  const approve = async (request: ApprovalRequest): Promise<ApprovalAnswer> => {
    if (options.yes) return { approved: true, scope: 'session' }
    blocked += 1
    return {
      approved: false,
      scope: 'once',
      // 这句话是写给模型看的，所以要说清「换条路」而不只是「不行」
      note:
        `这是非交互的一次性任务，没有人能回答审批，${request.tool.name} 被自动拒绝。` +
        '请改用只读工具把结论说清楚；确实需要动东西的话，让用户加 --yes 重跑。',
    }
  }

  const outcome = await runTurn({
    session,
    provider,
    line: options.line,
    write,
    out,
    approve,
    tty: false,
  })
  if (blocked > 0) {
    out(`（有 ${blocked} 次写操作被挡下了：非交互模式默认只读，要真动东西请加 --yes）`)
  }
  return {
    code: outcome.summary.error ? 1 : 0,
    tools: outcome.summary.tools.map((tool) => tool.name),
    text: outcome.summary.text,
    blocked,
  }
}
