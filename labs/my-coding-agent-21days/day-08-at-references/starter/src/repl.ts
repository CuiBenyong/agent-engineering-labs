/**
 * REPL：读一行、判断是命令还是对话、执行、打印。来自 D7，本天改了一处：
 * 每次拿到一句用户输入，先解析里面的 @ 引用、展开、按预算裁剪，
 * 把注入内容作为**单独一条消息**放在用户消息之前，并把这次的来源清单打在终端上。
 *
 * 注意顺序：注入消息在前、用户原话在后。这样模型读到的是「先材料后问题」，
 * 而用户在历史里看到的仍然是自己说过的那句话。
 *
 * 原 D7 说明：本天改了三处：
 *   1. 启动时开一条会话日志，或者按 --resume 接上一条已有的（重放恢复消息数组）
 *   2. 每一轮的事件流套一层 recordTurn，边跑边落盘
 *   3. 多了 /sessions、/log、/fork 三条命令（在 commands.ts 里）
 *
 * 恢复的现象要说清楚：**重启之后模型能引用上一次查明的事实**，因为那些事实就在
 * 重放出来的消息数组里。它不是「记住了」，是「历史被重新搬回来了」——第一天说过
 * 模型没有记忆，今天这条持久化没有推翻那句话，只是把搬历史的活儿从内存挪到了磁盘。
 *
 * 原 D6 说明：本天改了两处：
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
import { COMMANDS, newSession, parseCommand, persistRules, replaceHistory } from './commands.js'
import type { ApprovalRequest, ApprovalAnswer, Scope } from './kernel/approval.js'
import type { CliOptions } from './cli.js'
import { SessionLog, latestSessionId, listSessions } from './session/log.js'
import { recordTurn } from './session/record.js'
import { replay } from './session/replay.js'
import { buildInjection, userTextForModel } from './refs/inject.js'
import { contentToText } from './kernel/types.js'
import type { Root } from './refs/expand.js'
import type { Session } from './commands.js'

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
  if (key.name === 'escape' && !key.meta) return true
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

/** --sessions：只列一下就退出 */
export async function printSessions(): Promise<void> {
  const all = await listSessions()
  if (all.length === 0) {
    process.stdout.write('还没有任何会话（跑一轮对话就会有了）\n')
    return
  }
  for (const info of all) {
    const broken = info.broken ? '（最后一行不完整）' : ''
    process.stdout.write(`${info.id}  ${info.events} 条事件  ${info.updatedAt}${broken}\n`)
  }
}

/**
 * 开一条会话，或者接上一条。返回的 note 是给用户看的一句话——
 * 恢复这件事一定要说清楚「接的是哪条、恢复了多少」，否则用户分不清
 * 「它记得」和「它在瞎猜」。
 */
export async function openSession(
  out: (line: string) => void,
  options: CliOptions
): Promise<Session> {
  if (!options.resume) return newSession(out, await SessionLog.create())

  const id = options.resume === true ? await latestSessionId() : options.resume
  if (!id) {
    out('没有可恢复的会话，开一条新的。')
    return newSession(out, await SessionLog.create())
  }

  const { log, read } = await SessionLog.open(id)
  const restored = replay(read.events)
  const session = newSession(out, log)
  if (restored.messages.length > 0) replaceHistory(session.messages, restored.messages)
  out(
    `已恢复会话 ${id}：重放 ${restored.replayed} 条消息事件` +
      `（另有 ${restored.skipped} 条只用于展示与审计），累计 ${restored.tokens} token。`
  )
  if (read.stoppedAtLine !== null) {
    out(`⚠ 日志第 ${read.stoppedAtLine} 行读不下去了：${read.reason}。已停在前一条完整事件。`)
  }
  if (restored.forkedFrom) {
    out(
      `（这条会话是从 ${restored.forkedFrom.from} 的第 ${restored.forkedFrom.atSeq} 条分叉出来的）`
    )
  }
  return session
}

/**
 * 引用解析的两个根，按顺序找。
 *
 * 为什么是两个：用户心里的「这个文件」可能相对沙盒仓库（他正在让 Agent 改的那个仓库），
 * 也可能相对他启动 mca 的目录。两处都找，但**必须把实际解析到哪个根打出来**——
 * 猜对了不说，等于让他下次继续猜。
 */
export function referenceRoots(): Root[] {
  return [
    { name: 'work/repo', dir: REPO_DIR },
    { name: '当前目录', dir: process.cwd() },
  ]
}

/**
 * 把一句用户输入变成消息数组里的**两条**消息，返回要打在终端上的报账。
 *
 * 两条而不是一条，是今天最重要的一个结构决定：注入的资料一条、用户原话一条。
 * 三个理由：模型回答时会引用用户写的那个 @ 名字；用户翻历史时看到的是自己说过的话；
 * 第十二天压缩上下文时可以优先丢掉注入那条而保留原话——拼在一起就只能整条丢。
 */
export async function pushUserTurn(session: Session, line: string): Promise<string[]> {
  const injection = await buildInjection(line, { roots: referenceRoots() })
  // TODO(5)：现在是把注入内容和用户原话拼成**一条**消息。改成两条：
  // 先 push injection.message（不为 null 时），再 push 用户原话那一条。
  const merged = injection.message
    ? `${contentToText(injection.message.content)}\n\n${userTextForModel(line)}`
    : userTextForModel(line)
  session.messages.push({ role: 'user', content: merged })
  return injection.report
}

export async function startRepl(options: CliOptions = {}): Promise<void> {
  const write = (chunk: string) => void stdout.write(chunk)
  const out = (line: string) => write(`${line}\n`)
  const session = await openSession(out, options)
  const provider = createProvider()
  await seedRepo()

  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '你 > ' })
  const queue = new LineQueue()
  rl.on('line', (line) => queue.push(line))
  rl.on('close', () => queue.close())

  out(
    `mca 已启动（${provider.id} · ${provider.model}），会话 ${session.log.id}，` +
      `${session.registry.size} 个工具。输入 /help 看命令，/sessions 看会话，` +
      `/fork 看分叉点，跑到一半按 Esc 可以打断这一轮，/exit 退出。`
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

    // 先解析并展开 @ 引用：注入内容单独一条消息，用户原话原样保留
    for (const row of await pushUserTurn(session, line)) out(row)
    out('mca >')
    // ② 每一轮一个新的控制器：取消的粒度是「这一轮」，不是整个会话
    active = new AbortController()
    await renderTurn(
      // recordTurn 是透明包装：事件原样往下传，路过时顺手落盘
      recordTurn(
        session.log,
        session.messages,
        run({
          provider,
          registry: session.registry,
          messages: session.messages,
          cwd: REPO_DIR,
          signal: active.signal,
          gate: { state: session.permissions, approve, persist: persistRules, log: out },
        })
      ),
      write
    )
    active = null
    rl.prompt()
  }

  rl.close()
}
