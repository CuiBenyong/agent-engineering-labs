/**
 * REPL：读一行、判断是命令还是对话、执行、打印。来自 D3，本天只改了一处：
 * 注册表里多了三个会改东西的工具（edit_file、create_file、run_command），
 * 于是 /tools 打印出来第一次出现「会改东西」这个标记——D5 的审批门就从这里长出来。
 *
 * 原 D3 说明：来自 D2，本天改了三处：
 *   1. 启动时注册三个只读工具，并把沙盒仓库 work/repo 作为工具的工作目录
 *   2. 加一条 /tools 命令，把工具清单（连带 readOnly 标记）打出来
 *   3. 每一轮把 cwd 传给循环
 *
 * 原 D2 说明：来自 D1，本天改了两处：
 *   1. 渲染改成流式：命令的输出仍然是「一行一行」，模型的输出交给渲染器逐片写
 *      （所以这里区分了 out 与 write 两个出口，前者补换行，后者原样写）
 *   2. 接上 Ctrl+C：一轮正在跑就打断这一轮，没有在跑就退出
 *
 * 关键的一条设计（D1 定的）：命令与对话在入口处就分成两条路径，命令表是数据不是 if 链。
 */
import readline from 'node:readline'
import { stdin, stdout } from 'node:process'
import type { Message } from './kernel/types.js'
import { ToolRegistry } from './kernel/tools.js'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { createProvider } from './providers/index.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { loadConfig } from './config.js'
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
  out(line: string): void
}

const SYSTEM_PROMPT =
  '你是 mca，一个运行在终端里的编码助手。回答简洁，用中文。' +
  '你有六个工具：glob 找文件、grep 搜内容、read_file 读文件，' +
  'edit_file 精确替换、create_file 新建文件、run_command 执行命令。' +
  '所有路径都是相对工作目录的相对路径。' +
  '改文件之前必须先 read_file 确认原文，edit_file 的 old_string 必须逐字一致且在文件里唯一。'

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
    out,
  }
}

export async function startRepl(): Promise<void> {
  const write = (chunk: string) => void stdout.write(chunk)
  const out = (line: string) => write(`${line}\n`)
  const session = newSession(out)
  const provider = createProvider()
  // 工具的工作目录是沙盒仓库，不是当前目录：读权限也要有边界
  await seedRepo()

  // 用 node:readline 的异步迭代器，而不是 readline/promises 的 question()：
  // 管道喂输入时 stdin 会读到 EOF，question() 返回的 promise 在某些 Node 版本里
  // 既不 resolve 也不 reject，进程会以"未结算的顶层 await"退出（exit code 13）。
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '你 > ' })
  out(
    `mca 已启动（${provider.id} · ${provider.model}），工作目录 work/repo，` +
      `${session.registry.size} 个工具（其中 ` +
      `${session.registry.list().filter((t) => !t.readOnly).length} 个会改东西）。` +
      `输入 /help 看命令，/exit 退出。`
  )

  // 打断：一轮正在跑就掐这一轮，没在跑就退出。真正的取消链路（一路传到子进程）是 D6。
  let active: AbortController | null = null
  rl.on('SIGINT', () => {
    if (active) {
      active.abort()
      return
    }
    rl.close()
  })

  rl.prompt()
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) {
      rl.prompt()
      continue
    }

    const command = parseCommand(line)
    if (command) {
      const handler = COMMANDS.find((c) => c.name === command.name)
      if (!handler) {
        out(`没有这条命令：/${command.name}（/help 看全部）`)
        rl.prompt()
        continue
      }
      const keepGoing = await handler.run(command.args, session)
      if (!keepGoing) break
      rl.prompt()
      continue
    }

    session.messages.push({ role: 'user', content: line })
    out('mca >')
    active = new AbortController()
    await renderTurn(
      run({
        provider,
        registry: session.registry,
        messages: session.messages,
        cwd: REPO_DIR,
        signal: active.signal,
      }),
      write
    )
    active = null
    rl.prompt()
  }

  rl.close()
}
