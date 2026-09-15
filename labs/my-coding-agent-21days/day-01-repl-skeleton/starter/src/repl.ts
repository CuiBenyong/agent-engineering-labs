/**
 * REPL：读一行、判断是命令还是对话、执行、打印。
 *
 * 关键的一条设计：命令与对话在入口处就分成两条路径，命令表是数据不是 if 链。
 * 后面二十天要加 /help /clear /resume /rewind /compact /context 等十几条命令，
 * 分不开的话这个文件会烂成一坨。
 */
import readline from 'node:readline'
import { stdin, stdout } from 'node:process'
import type { Message } from './kernel/types.js'
import { ToolRegistry } from './kernel/tools.js'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { createProvider } from './providers/index.js'
import { seedRepo } from './seed.js'
import { loadConfig } from './config.js'

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
  '你是 mca，一个运行在终端里的编码助手。回答简洁，用中文。今天你还没有任何工具。'

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
  // TODO(3) 实现命令解析。
  //
  // 要点：
  //   1. 不以 / 开头的一律返回 null（那是对话，不是命令）
  //   2. /help 这种没有参数的，args 是空字符串
  //   3. /seed work/repo 这种，name 是 seed、args 是 work/repo
  //   4. 别在这里判断命令存不存在——那是调用方的事，解析器只负责拆
  void line
  return null
}

export function newSession(out: (line: string) => void): Session {
  return {
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
    registry: new ToolRegistry(),
    out,
  }
}

export async function startRepl(): Promise<void> {
  const out = (line: string) => stdout.write(`${line}\n`)
  const session = newSession(out)
  const provider = createProvider()

  // 用 node:readline 的异步迭代器，而不是 readline/promises 的 question()：
  // 管道喂输入时 stdin 会读到 EOF，question() 返回的 promise 在某些 Node 版本里
  // 既不 resolve 也不 reject，进程会以"未结算的顶层 await"退出（exit code 13）。
  // 迭代器天然在 EOF 时结束循环，REPL 与管道两种用法都对。
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '你 > ' })
  out(`mca 已启动（${provider.id} · ${provider.model}）。输入 /help 看命令，/exit 退出。`)
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
    await renderTurn(run({ provider, registry: session.registry, messages: session.messages }), out)
    rl.prompt()
  }

  rl.close()
}
