/**
 * 斜杠命令表。来自 D14，本天改了两处：
 *   1. Session / SessionDeps / createRegistry / newSession / replaceHistory 整体搬到
 *      session-factory.ts —— D14 的这个文件已经 337 行，本课单文件上限 350，
 *      而今天要往命令表里加一条 /mcp。**文件到了上限就拆。**
 *   2. 命令表末尾展开 MCP_COMMANDS（/mcp 一条）
 *
 * 原 D14 说明：本天改了三处：
 *   1. Session 上多了一个 checkpoints：文件快照那一条时间线的写入端
 *      （**它和 session.log 是两个东西**，这正是今天要说清的那件事）
 *   2. 命令表末尾展开 SNAPSHOT_COMMANDS（/checkpoints、/rewind 两条）
 *   3. SessionDeps 多了一个 checkpoints，好让 --resume 接着已有的快照编号写下去
 *
 * 原 D13 说明：本天改了四处：
 *   1. Session 上多了一个 plan：模式、已批准的计划、问过的问题、实际改动都在里面
 *   2. createRegistry 变成要传依赖的工厂：ask_user 与 submit_plan 都需要闭包注入
 *      （提问渠道、计划状态、权限表），而工具注册仍然只有这一处
 *   3. 命令表末尾展开 PLAN_COMMANDS（/plan、/check 两条）
 *   4. 系统提示里多了一段：什么时候该问、探索模式下能做什么、计划要写清什么
 *
 * 原 D12 说明：本天改了三处：
 *   1. Session 上多了一个 calibrator：token 估算器的样本与系数按会话攒
 *   2. 命令表末尾展开 CONTEXT_COMMANDS（/budget、/tokens、/compact 三条，
 *      写在 context/commands.ts 里——这个文件已经 273 行，本课单文件上限 350）
 *   3. 系统提示里多了一句「上下文可能被压缩过」，理由见下面那段注释
 *
 * 原 D7 说明：本天加了三条与会话日志有关的命令：
 *   /sessions  列出磁盘上的会话（最近的在前，坏掉的会标出来）
 *   /log       打印当前会话最近的事件，带 seq
 *   /fork      不带参数列出可分叉的位置，带一个 seq 就分叉过去并切换过去
 *
 * Session 上因此多了两样东西：一个可替换的 log（分叉之后要换成新的那条），
 * 以及一个 replaceHistory，用来把重放出来的消息**原地**换进 messages 数组——
 * 不能直接赋一个新数组，因为循环持有的是同一个数组引用。
 *
 * 原 D6 说明：命令表从 repl.ts 搬出来，并加了一条 /limits。
 *
 * 为什么要搬：D5 的 repl.ts 已经 305 行，今天还要往里加取消按键处理。
 * 本课的单文件上限是 350 行，而这一堆命令与 REPL 的输入循环本来就是两件事——
 * 命令表是数据，输入循环是控制流。**文件到了上限就拆，是这门课的纪律之一：
 * 一个五百行的文件不会因为「都是相关的东西」而变得好读。**
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Message } from './kernel/types.js'
import { loadConfig } from './config.js'
import { seedRepo } from './seed.js'
import { describeRule, type PermissionState } from './kernel/permissions.js'
import { forkSession, listSessions, readEvents } from './session/log.js'
import { parseReferences } from './refs/parse.js'
import { REF_BUDGET_CHARS } from './refs/budget.js'
import { forkPoints } from './session/replay.js'
import { DEFAULT_LIMITS } from './kernel/limits.js'
import { CONTEXT_COMMANDS } from './context/commands.js'
import { PLAN_COMMANDS } from './plan/commands.js'
import { SNAPSHOT_COMMANDS } from './snapshot/commands.js'
import { MCP_COMMANDS } from './mcp/commands.js'
import { replaceHistory, type Session } from './session-factory.js'
import { REPEAT_THRESHOLD } from './kernel/repeat.js'

export interface Command {
  name: string
  help: string
  /** 返回 false 表示要退出 REPL */
  run(args: string, session: Session): Promise<boolean> | boolean
}

/** 规则持久化的位置。配置该放哪、怎么分层是 D21 的题目 */
export const RULES_FILE = path.resolve(process.cwd(), 'work/permissions.json')

export async function persistRules(state: PermissionState): Promise<void> {
  await fs.mkdir(path.dirname(RULES_FILE), { recursive: true })
  await fs.writeFile(RULES_FILE, JSON.stringify({ rules: state.rules }, null, 2), 'utf8')
}

export const COMMANDS: Command[] = [
  {
    name: 'help',
    help: '列出所有命令',
    run: (_args, session) => {
      for (const command of COMMANDS) session.out(`  /${command.name}  ${command.help}`)
      return true
    },
  },
  {
    name: 'clear',
    help: '清空对话历史（保留系统提示）',
    run: (_args, session) => {
      session.messages.splice(1, session.messages.length - 1)
      session.out('已清空对话历史')
      return true
    },
  },
  {
    name: 'seed',
    help: '重新生成 work/repo 沙盒仓库',
    run: async (_args, session) => {
      const files = await seedRepo()
      session.out(`沙盒仓库已生成：work/repo（${files.length} 个文件）`)
      return true
    },
  },
  {
    name: 'permissions',
    help: '列出当前的权限规则',
    run: (_args, session) => {
      for (const rule of session.permissions.rules) session.out(`  ${describeRule(rule)}`)
      session.out('  其余写操作：默认 ask；只读工具：默认 allow')
      return true
    },
  },
  {
    name: 'limits',
    help: '显示循环的三条硬上限',
    run: (_args, session) => {
      session.out(`  轮数上限  ${DEFAULT_LIMITS.maxRounds} 圈`)
      session.out(`  时长上限  ${DEFAULT_LIMITS.maxMs / 1000} 秒`)
      session.out(`  用量上限  ${DEFAULT_LIMITS.maxTokens} token（输入与输出相加，不折算金额）`)
      session.out(`  打转阈值  同工具同参数连续 ${REPEAT_THRESHOLD} 次就打断`)
      return true
    },
  },
  {
    name: 'sessions',
    help: '列出磁盘上的会话（最近的在前）',
    run: async (_args, session) => {
      const all = await listSessions()
      if (all.length === 0) session.out('  还没有任何会话')
      for (const info of all) {
        const mark = info.id === session.log.id ? '*' : ' '
        const broken = info.broken ? '（最后一行不完整）' : ''
        session.out(`${mark} ${info.id}  ${info.events} 条事件  ${info.updatedAt}${broken}`)
      }
      return true
    },
  },
  {
    name: 'log',
    help: '打印当前会话最近的事件（带 seq）',
    run: async (args, session) => {
      const limit = Number(args) > 0 ? Number(args) : 8
      const read = await readEvents(session.log.id)
      for (const event of read.events.slice(-limit)) {
        session.out(`  #${event.seq} ${event.type} ${summarize(event)}`)
      }
      if (read.stoppedAtLine !== null) {
        session.out(`  ⚠ 第 ${read.stoppedAtLine} 行读不下去了：${read.reason}`)
      }
      return true
    },
  },
  {
    name: 'fork',
    help: '不带参数列出可分叉的位置；/fork 12 从第 12 条事件分叉出新会话',
    run: async (args, session) => {
      const read = await readEvents(session.log.id)
      const points = forkPoints(read.events)
      if (!args) {
        session.out('  可以从这些位置分叉（只有干净的边界才能分）：')
        for (const point of points)
          session.out(`    /fork ${point.seq}  ${point.role}: ${point.preview}`)
        return true
      }
      const seq = Number(args)
      if (!points.some((p) => p.seq === seq)) {
        session.out(`  第 ${seq} 条不是一个干净的分叉点（/fork 不带参数看可选位置）`)
        return true
      }
      const { log, copied } = await forkSession(session.log.id, seq)
      const restored = await readEvents(log.id)
      replaceHistory(session.messages, replayMessages(restored.events))
      session.log = log
      session.out(`  已分叉出 ${log.id}（复制了 ${copied} 条事件），母会话一个字节都没动`)
      return true
    },
  },
  {
    name: 'refs',
    help: '解释一句话里的 @ 引用会注入什么（不真的发给模型）',
    run: (args, session) => {
      if (!args) {
        session.out('  用法：/refs 看看 @src/calc.js 和 @src/')
        return true
      }
      // 只解析不展开：想看注入量直接说那句话就行，这里是给「我写对了吗」用的
      for (const ref of parseReferences(args)) {
        session.out(`  ${ref.raw}  →  ${ref.kind}  目标 ${ref.target}`)
      }
      session.out(`  引用预算 ${REF_BUDGET_CHARS} 字符，单个来源上限是它的一半`)
      return true
    },
  },
  {
    name: 'tools',
    help: '列出已注册的工具',
    run: (_args, session) => {
      for (const tool of session.registry.list()) {
        session.out(`  ${tool.name}${tool.readOnly ? '（只读）' : '（会改东西）'}`)
      }
      return true
    },
  },
  {
    name: 'model',
    help: '显示当前网关与模型',
    run: (_args, session) => {
      const config = loadConfig()
      session.out(config.mock ? '离线剧本（MOCK=1）' : `${config.baseUrl} · ${config.model}`)
      return true
    },
  },
  ...CONTEXT_COMMANDS,
  ...PLAN_COMMANDS,
  ...SNAPSHOT_COMMANDS,
  ...MCP_COMMANDS,
  {
    name: 'exit',
    help: '退出',
    run: () => false,
  },
]

/** 把一行输入解析成命令名与参数；不是命令就返回 null */
export function parseCommand(line: string): { name: string; args: string } | null {
  if (!line.startsWith('/')) return null
  const trimmed = line.slice(1).trim()
  const space = trimmed.indexOf(' ')
  if (space === -1) return { name: trimmed, args: '' }
  return { name: trimmed.slice(0, space), args: trimmed.slice(space + 1).trim() }
}

/** 事件里只有 message 参与重建，理由见 session/replay.ts */
function replayMessages(events: Parameters<typeof forkPoints>[0]): Message[] {
  return events.flatMap((event) => (event.type === 'message' ? [event.message] : []))
}

/** /log 那一行的摘要。事件类型不同，值得看的东西也不同 */
function summarize(event: Parameters<typeof forkPoints>[0][number]): string {
  switch (event.type) {
    case 'message':
      return `${event.message.role} ${String(event.message.content).slice(0, 32)}`
    case 'tool_end':
      return `${event.id} ${event.result.ok ? 'ok' : '失败'} ${event.result.content.length} 字符`
    case 'usage':
      return `输入 ${event.promptTokens} / 输出 ${event.completionTokens} token`
    case 'error':
      return event.message.slice(0, 40)
    case 'fork':
      return `来自 ${event.from} 的第 ${event.atSeq} 条`
  }
}
