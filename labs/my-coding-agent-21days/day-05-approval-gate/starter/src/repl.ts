/**
 * REPL：读一行、判断是命令还是对话、执行、打印。来自 D4，本天改了三处：
 *   1. 输入模型换成一个行队列。原因是今天出现了「嵌套提问」：一轮跑到一半要停下来
 *      问一句「允许吗」。直接在 for await 循环里再读一行会和迭代器抢同一批 line 事件，
 *      于是主循环与审批提示轮流从同一个队列里取行，谁在等谁拿到。
 *   2. 接上审批门：写工具与命令工具停下来问，只读工具直接过。
 *   3. 加一条 /permissions 命令，把当前规则表打出来。
 *
 * 原 D4 说明：来自 D3，本天只改了一处：
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
import { createState, describeRule, type PermissionState } from './kernel/permissions.js'
import type { ApprovalRequest, ApprovalAnswer, Scope } from './kernel/approval.js'
import fs from 'node:fs/promises'
import path from 'node:path'
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

/**
 * 行队列：readline 的 line 事件进来，谁在等谁取走。
 * 主循环与审批提示共用它，所以同一行永远只被一个消费者拿到。
 */
export class LineQueue {
  private readonly lines: string[] = []
  private readonly waiters: Array<(line: string | null) => void> = []
  private closed = false

  push(line: string): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(line)
    else this.lines.push(line)
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0) this.waiters.shift()?.(null)
  }

  /** 取下一行；输入结束时返回 null */
  next(): Promise<string | null> {
    const buffered = this.lines.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

/** 规则持久化的位置。配置该放哪、怎么分层是 D21 的题目，今天只演示「记住」这件事 */
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
  '有些操作需要用户批准，被拒绝时不要重试同一个调用，改走别的路径或者说明原因。'

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

/**
 * 终端里的审批提示。四个选项对应三种记忆范围：
 *   y 这次可以（本轮）｜ a 以后都可以（本会话）｜ w 写进配置（持久）｜ n 不行
 * 提示里必须说清「为什么问你」——用户看不到规则表，只能靠这一行判断。
 */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  const target = request.subject.path ?? request.subject.command ?? ''
  return [
    `需要确认：${request.tool.name} ${target}`,
    `原因：${request.verdict.reason}`,
    '允许吗？y 这次可以 / a 本会话都可以 / w 写进配置 / n 不行 ',
  ].join('\n')
}

/** 把一行回答解析成审批结果。看不懂的回答按拒绝处理，不按同意 */
export function parseApprovalAnswer(line: string | null): ApprovalAnswer {
  const answer = (line ?? '').trim().toLowerCase()
  const scopes: Record<string, Scope> = { y: 'once', a: 'session', w: 'config' }
  const scope = scopes[answer]
  if (scope) return { approved: true, scope }
  return {
    approved: false,
    scope: 'once',
    note:
      answer === 'n' || answer === ''
        ? '用户拒绝了这次操作'
        : `用户的回答是「${answer}」，按拒绝处理`,
  }
}

export async function startRepl(): Promise<void> {
  const write = (chunk: string) => void stdout.write(chunk)
  const out = (line: string) => write(`${line}\n`)
  const session = newSession(out)
  const provider = createProvider()
  await seedRepo()

  // 用 node:readline 的 line 事件加一个行队列，而不是 readline/promises 的 question()：
  // question() 在管道喂输入读到 EOF 之后既不 resolve 也不 reject（见 D1 的坑），
  // 而队列天然支持「主循环与审批提示轮流取行」这件今天才出现的需求。
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '你 > ' })
  const queue = new LineQueue()
  rl.on('line', (line) => queue.push(line))
  rl.on('close', () => queue.close())

  out(
    `mca 已启动（${provider.id} · ${provider.model}），工作目录 work/repo，` +
      `${session.registry.size} 个工具（其中 ` +
      `${session.registry.list().filter((t) => !t.readOnly).length} 个会改东西）。` +
      `输入 /help 看命令，/permissions 看权限规则，/exit 退出。`
  )

  let active: AbortController | null = null
  rl.on('SIGINT', () => {
    if (active) {
      active.abort()
      return
    }
    rl.close()
  })

  const approve = async (request: ApprovalRequest): Promise<ApprovalAnswer> => {
    out(formatApprovalPrompt(request))
    // 这个 await 就是「循环里的一次暂停」：模型在等，工具没执行，什么都没发生
    return parseApprovalAnswer(await queue.next())
  }

  rl.prompt()
  for (;;) {
    const raw = await queue.next()
    if (raw === null) break
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
        gate: { state: session.permissions, approve, persist: persistRules, log: out },
      }),
      write
    )
    active = null
    rl.prompt()
  }

  rl.close()
}
