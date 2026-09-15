/**
 * REPL：读一行、判断是命令还是对话、执行、打印。来自 D14，本天改了一处：
 * 启动时先把 MCP server 挂上（bootMcp），把挂好的 mount 交给会话，退出时收摊。
 *
 * 顺序也是死的：**先挂 MCP，再建会话。** 工具注册表是在 newSession 里一次性造出来的，
 * 挂晚了远端工具就进不了那张表，而且不会有任何东西报错——模型只是永远不提它们。
 * 真要做「运行中挂载」，代价是**动态增删工具会打掉提示缓存**（工具表在提示前缀里），
 * 那是另一个决定，本课不做。
 *
 * 原 D14 说明：本天改了一处：
 * 启动时给整个沙盒仓库拍一张**基线快照**，然后（只有开了 INJECT=dirty 时）
 * 往仓库里塞一段「用户自己手写、还没提交」的改动。
 *
 * 顺序是死的：**先拍基线，再注入。** 反过来的话那段手写改动就成了基线的一部分，
 * 于是「工作区里有未记录的改动」这条检查永远查不出东西——本天最重要的那条现象
 * 就看不到了。
 *
 * 原 D13 说明：本天改了两处：
 *   1. 多了一个提问渠道：ask_user 工具要问的问题从这里摆出去、从同一个行队列收回来。
 *      **它和审批提问共用那个队列**——D5 造行队列时就是为了「一轮跑到一半停下来问一句」，
 *      今天是第二个用它的人，一行新的排队逻辑都不用写。
 *   2. 审批提示对 submit_plan 特判：摆出去的不是「需要确认：submit_plan」这种废话，
 *      而是整份计划。**这是渲染层的事，所以它就该写在渲染层**——不是给 AgentEvent 加事件类型。
 *
 * 原 D12 说明：本天把「跑一轮」那一段
 * 整块搬到了 turn.ts（连同 D8 的 pushUserTurn 与 referenceRoots），
 * 这个文件只剩下它真正的职责：按键、命令分发、提示符。
 *
 * 搬家的直接原因是行数——D8 的这个文件已经 303 行，本课上限 350，而今天要在
 * 一轮里再叠压缩判定与用量取样两层。**文件到了上限就拆**，是这门课的纪律之一。
 *
 * 原 D8 说明：每次拿到一句用户输入，先解析里面的 @ 引用、展开、按预算裁剪，
 * 把注入内容作为单独一条消息放在用户消息之前，并把这次的来源清单打在终端上。
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
import type { CliOptions } from './cli.js'
import { stdin, stdout } from 'node:process'
import { createProvider } from './providers/index.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { CheckpointLog } from './snapshot/log.js'
import { captureBaseline } from './snapshot/capture.js'
import { applyDirtyInjection } from './snapshot/dirty.js'
import { COMMANDS, parseCommand } from './commands.js'
import { bootMcp, shutdownMcp } from './mcp/boot.js'
import { openSession, printSessions } from './session/open.js'
import { replaceHistory, type Session } from './session-factory.js'
import type { ApprovalRequest, ApprovalAnswer, Scope } from './kernel/approval.js'
import { runTurn } from './turn.js'
import { reviewPlanCall, SUBMIT_PLAN } from './plan/submit.js'

export type { Command } from './commands.js'
export { printSessions } from './session/open.js'
export type { Session } from './session-factory.js'

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
 *
 * 本天多了一条 submit_plan 的分支。为什么不给它另做一套「计划审批」的链路：
 * 计划审批和工具审批问的是同一个问题——「这件事我能不能做」。不同的只是
 * **摆给用户看的内容**，而那是渲染层的职责。所以这里只多了一次特判，
 * 循环、协议、门一个字都没动。
 *
 * 计划审批只给 y / n 两个选项：a 与 w 的含义是「以后同样的操作都别问了」，
 * 而「以后所有计划都自动批准」正好把计划模式的意义抹掉。
 */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  if (request.call.name === SUBMIT_PLAN) {
    const review = reviewPlanCall(request.call)
    return [...review.lines, '批准这份计划吗？y 批准并开始执行 / n 不批（说说哪里要改）'].join('\n')
  }
  const target = request.subject.path ?? request.subject.command ?? ''
  return [
    `需要确认：${request.tool.name} ${target}`,
    `原因：${request.verdict.reason}`,
    '允许吗？y 这次可以 / a 本会话都可以 / w 写进配置 / n 不行 ',
  ].join('\n')
}

/**
 * 计划审批的回答。它和工具审批分开解析，因为**预检在这里**：
 * 一份格式不合格的计划连问都不该问出去，直接当「拒绝」把问题清单回灌给模型。
 */
export function planApprovalAnswer(request: ApprovalRequest, line: string | null): ApprovalAnswer {
  const review = reviewPlanCall(request.call)
  if (!review.plan) {
    return { approved: false, scope: 'once', note: `这份计划不合格：${review.problems.join('；')}` }
  }
  const answer = (line ?? '').trim().toLowerCase()
  if (answer === 'y') return { approved: true, scope: 'once' }
  return {
    approved: false,
    scope: 'once',
    note: answer && answer !== 'n' ? `用户没有批准，他说：${line?.trim()}` : '用户没有批准这份计划',
  }
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

export async function startRepl(options: CliOptions = {}): Promise<void> {
  const write = (chunk: string) => void stdout.write(chunk)
  const out = (line: string) => write(`${line}\n`)
  // 提问渠道要在建会话之前就绑好：ask_user 工具是在 createRegistry 里造出来的，
  // 渠道是闭包进去的。队列本身是下面才建的，所以这里用一个后填的引用
  let queue: LineQueue | null = null
  // 只负责收一行：问题本身由 ask_user 工具打出来（它拿到的 log 就是这个 out），
  // 两边都打会在屏幕上出现两遍同样的问题
  const ask = async (): Promise<string | null> => (queue ? queue.next() : null)
  const provider = createProvider()
  await seedRepo()
  const checkpoints = await CheckpointLog.open()
  // 先挂 MCP：工具注册表是在建会话时一次性造出来的，挂晚了远端工具就进不了那张表
  const booted = await bootMcp(out)
  const session = await openSession(out, options, {
    ask,
    checkpoints,
    ...(booted.mount ? { mcp: booted.mount } : {}),
  })

  // 先拍基线：它让「回到什么都还没发生的时候」变成一个真实可达的状态
  const baseline = await captureBaseline(checkpoints, REPO_DIR)
  out(`已拍下基线快照：${baseline} 个文件（/checkpoints 看时间线，/rewind 回退）`)
  // 再注入。只有 INJECT=dirty 时才会发生，见 snapshot/dirty.ts
  const dirty = await applyDirtyInjection(REPO_DIR)
  if (dirty.applied) {
    out(`（注入：${dirty.path} 里多了一段你自己手写、还没提交的内容，它不在任何快照里）`)
  }

  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '你 > ' })
  queue = new LineQueue()
  const lines = queue
  rl.on('line', (line) => lines.push(line))
  rl.on('close', () => lines.close())

  out(
    `mca 已启动（${provider.id} · ${provider.model}），会话 ${session.log.id}，` +
      `${session.registry.size} 个工具（其中 ${booted.mount?.list().length ?? 0} 个来自 MCP server，` +
      `/mcp 看来源）。输入 /help 看命令，/sessions 看会话，` +
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
    const answered = await lines.next()
    return request.call.name === SUBMIT_PLAN
      ? planApprovalAnswer(request, answered)
      : parseApprovalAnswer(answered)
  }

  rl.prompt()
  for (;;) {
    const raw = await lines.next()
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

    // 一轮的全部流水线都在 turn.ts 里：先压旧上下文、再注入 @ 引用、
    // 跑循环时顺手落盘与取样、收尾校准估算器
    // ② 每一轮一个新的控制器：取消的粒度是「这一轮」，不是整个会话
    active = new AbortController()
    await runTurn({
      session,
      provider,
      line,
      write,
      out,
      signal: active.signal,
      approve,
    })
    active = null
    rl.prompt()
  }

  rl.close()
  // 子进程不会跟着父进程一起死，不收摊就会在机器上留一串孤儿 server
  await shutdownMcp(booted)
}
