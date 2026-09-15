/**
 * 斜杠命令表与会话构造。来自 D5 的 repl.ts，本天只是搬了个文件，并加了一条 /limits。
 *
 * 为什么要搬：D5 的 repl.ts 已经 305 行，今天还要往里加取消按键处理。
 * 本课的单文件上限是 350 行，而这一堆命令与 REPL 的输入循环本来就是两件事——
 * 命令表是数据，输入循环是控制流。**文件到了上限就拆，是这门课的纪律之一：
 * 一个五百行的文件不会因为「都是相关的东西」而变得好读。**
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Message } from './kernel/types.js'
import { ToolRegistry } from './kernel/tools.js'
import { loadConfig } from './config.js'
import { seedRepo } from './seed.js'
import { createState, describeRule, type PermissionState } from './kernel/permissions.js'
import { DEFAULT_LIMITS } from './kernel/limits.js'
import { REPEAT_THRESHOLD } from './kernel/repeat.js'
import { readFileTool } from './tools/read-file.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'
import { createFileTool, editFileTool } from './tools/edit-file.js'
import { runCommandTool } from './tools/command.js'

export interface Command {
  name: string
  help: string
  /** 返回 false 表示要退出 REPL */
  run(args: string, session: Session): Promise<boolean> | boolean
}

export interface Session {
  messages: Message[]
  registry: ToolRegistry
  permissions: PermissionState
  out(line: string): void
}

/** 规则持久化的位置。配置该放哪、怎么分层是 D21 的题目 */
export const RULES_FILE = path.resolve(process.cwd(), 'work/permissions.json')

export async function persistRules(state: PermissionState): Promise<void> {
  await fs.mkdir(path.dirname(RULES_FILE), { recursive: true })
  await fs.writeFile(RULES_FILE, JSON.stringify({ rules: state.rules }, null, 2), 'utf8')
}

const SYSTEM_PROMPT =
  '你是 mca，一个运行在终端里的编码助手。回答简洁，用中文。' +
  '你有六个工具：glob 找文件、grep 搜内容、read_file 读文件，' +
  'edit_file 精确替换、create_file 新建文件、run_command 执行命令。' +
  '所有路径都是相对工作目录的相对路径。' +
  '改文件之前必须先 read_file 确认原文，edit_file 的 old_string 必须逐字一致且在文件里唯一。' +
  '有些操作需要用户批准，被拒绝时不要重试同一个调用，改走别的路径或者说明原因。' +
  // 本天新增的这两句是配合今天的机制写的：工具结果里的失败原因就是它的下一步说明书
  '工具失败时先读结果里的原因：说了「原样重试」就重试一次，说了「换个做法」就换做法，' +
  '不要用同样的参数反复调同一个工具。'

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

/** 工具注册只有这一处：加一个工具不该动循环、渲染或 REPL 的任何一行 */
export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(globTool)
  registry.register(grepTool)
  registry.register(readFileTool)
  registry.register(editFileTool)
  registry.register(createFileTool)
  registry.register(runCommandTool)
  return registry
}

export function newSession(out: (line: string) => void): Session {
  return {
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
    registry: createRegistry(),
    permissions: createState(),
    out,
  }
}
