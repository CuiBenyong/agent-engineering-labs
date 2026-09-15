/**
 * REPL：读一行、判断是命令还是对话、执行、打印。来自 D5，本天改了两处：
 *   1. 斜杠命令表搬到了 commands.ts（D5 的这个文件已经 305 行，本课单文件上限 350）
 *   2. 接上取消按键：Esc 与 Ctrl+C 都能打断正在跑的这一轮
 *
 * 今天最值得看的是**取消链路的四环**，缺任何一环都会出现「按了没用」：
 *
 *   ① 按键        stdin 的 keypress 事件（只有真终端才有）
 *   ② 信号        AbortController.abort()，一个进程内的广播
 *   ③ 网络        provider.stream 把 signal 交给 fetch，fetch 才会真的断开连接
 *   ④ 子进程      ToolContext.signal 传到 run_command，它杀掉整个进程组
 *
 * ③ 和 ④ 是最容易漏的：只在循环里判断 signal.aborted，你会看到「打断」两个字立刻出现，
 * 但那条 curl 还在下载、那个测试进程还在跑。**取消要落到最外层的系统资源上才算取消。**
 *
 * 原 D5 说明：输入模型换成一个行队列，因为出现了「嵌套提问」——一轮跑到一半要停下来
 * 问一句「允许吗」。主循环与审批提示轮流从同一个队列里取行，谁在等谁拿到。
 *
 * 关键的一条设计（D1 定的）：命令与对话在入口处就分成两条路径，命令表是数据不是 if 链。
 */
import readline from 'node:readline'
import { stdin, stdout } from 'node:process'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { createProvider } from './providers/index.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { COMMANDS, newSession, parseCommand, persistRules } from './commands.js'
import type { ApprovalRequest, ApprovalAnswer, Scope } from './kernel/approval.js'

export type { Command, Session } from './commands.js'

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

/** keypress 事件给的按键描述。只声明我们用到的三个字段 */
export interface KeyInfo {
  name?: string
  ctrl?: boolean
  meta?: boolean
}

/**
 * 这个按键是要取消当前这一轮吗。
 *
 * 两个键都收：Esc 是「停下这一轮」，Ctrl+C 在有任务时也是停这一轮、没任务时才退出程序。
 * 单独抽成函数是为了能被自检直接断言——按键这一环在管道里跑不到，
 * 但「哪些键算取消」这条判断可以验。
 */
export function isCancelKey(key: KeyInfo | undefined): boolean {
  if (!key) return false
  // TODO(5)：把 Esc 也认成取消键（key.name 是 'escape'），但要排除带 meta 的组合键——
  // 终端里 Alt 加某个键会被上报成「meta 加 escape」，那不是用户想取消。
  return key.name === 'c' && Boolean(key.ctrl)
}

/**
 * 终端里的审批提示。四个选项对应三种记忆范围：
 *   y 这次可以（本轮）｜ a 以后都可以（本会话）｜ w 写进配置（持久）｜ n 不行
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

  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '你 > ' })
  const queue = new LineQueue()
  rl.on('line', (line) => queue.push(line))
  rl.on('close', () => queue.close())

  out(
    `mca 已启动（${provider.id} · ${provider.model}），工作目录 work/repo，` +
      `${session.registry.size} 个工具。输入 /help 看命令，/limits 看上限，` +
      `跑到一半按 Esc 可以打断这一轮，/exit 退出。`
  )

  let active: AbortController | null = null
  const cancel = (): void => {
    if (!active) return
    active.abort()
    out('（已请求取消：正在断开网络连接并杀掉子进程）')
  }

  // ① 按键这一环。只有真终端才有 keypress 事件，管道里不挂这个监听器——
  // 在非 TTY 上挂它会跟 readline 抢同一批输入字节
  if (stdin.isTTY) {
    readline.emitKeypressEvents(stdin, rl)
    stdin.on('keypress', (_chunk: string, key: KeyInfo) => {
      if (isCancelKey(key)) cancel()
    })
  }
  rl.on('SIGINT', () => {
    if (active) cancel()
    else rl.close()
  })

  const approve = async (request: ApprovalRequest): Promise<ApprovalAnswer> => {
    out(formatApprovalPrompt(request))
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
    // ② 每一轮一个新的控制器：取消的粒度是「这一轮」，不是整个会话
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
