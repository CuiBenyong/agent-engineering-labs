/**
 * REPL：读一行、判断是命令还是对话、执行、打印。来自 D20，本天只改了一处：
 * 扫技能从「包内那一个目录」换成三个来源（包内 / 用户 / 项目），见 ship/skill-roots.ts。
 * 全局安装之后包内那个 skills/ 跟着包跑到 npm 前缀里去了，用户的仓库约定显然不在那儿。
 *
 * 原 D20 说明：收摊时在 shutdownMcp / shutdownTasks 之后再关一次评估面板（shutdownPanel）。
 *
 * 原 D18 说明：本天改了三处，全是后台任务的：
 *   1. 启动时起任务表与进度接收端（bootTasks），退出时收摊（shutdownTasks）
 *   2. 把通知队列接到终端上：告诉它往哪打、怎么重画提示符、**现在能不能插话**
 *   3. 会话开始与结束时各跑一次生命周期钩子
 *
 * 还做了一次**纯搬运**：行队列、取消按键判定与三种审批提示搬到了 repl-input.ts
 * （这个文件已经贴着 350 行的上限），搬过去的代码一个字符都没改。
 *
 * 第 2 条里的 canInterrupt 是今天这个文件最该看的一行：只有「正等着用户输入」
 * **且用户还一个字都没敲**（rl.line 为空）时才允许插话。少了后半个条件，
 * 一条通知会把用户敲了一半的命令冲掉——终端里没有「把没打完的字先存起来」这回事。
 *
 * 原 D19 说明：启动时在 seedRepo 之后补一次 seedDemoShots，生成演示图与界面文案。
 *
 * 原 D16 说明：启动时扫一遍 skills/ 目录，把扫描结果交给会话。
 *
 * 顺序和 MCP 那条一样死：**先扫技能，再建会话。** 阶段一摘要是拼进系统提示的，
 * 而系统提示是在 newSession 里一次性写进消息数组的——扫晚了摘要就进不去，
 * 模型从头到尾不知道有技能可用，而且不会有任何东西报错。
 *
 * 原 D15 说明：本天改了一处：
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
import { shutdownPanel } from './evals/commands.js'
import { scanAllSkills } from './ship/skill-roots.js'
import { bootTasks, shutdownTasks } from './tasks/boot.js'
import { runLifecycle } from './hooks/wrap.js'
// D19 接线：演示素材（三张图 + 沙盒仓库里的界面文案）随 seed 一起生成
import { seedDemoShots } from './vision/demo.js'
import { openSession, printSessions } from './session/open.js'
import { replaceHistory, type Session } from './session-factory.js'
import type { ApprovalRequest, ApprovalAnswer } from './kernel/approval.js'
import { runTurn } from './turn.js'
import { SUBMIT_PLAN } from './plan/submit.js'
import {
  LineQueue,
  isCancelKey,
  formatApprovalPrompt,
  planApprovalAnswer,
  parseApprovalAnswer,
  type KeyInfo,
} from './repl-input.js'

export type { Command } from './commands.js'
export { printSessions } from './session/open.js'
export type { Session } from './session-factory.js'
export * from './repl-input.js'

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
  // 顺序是死的：先 seedRepo 再 seedDemoShots，反过来界面文案会被沙盒仓库的重建冲掉
  await seedDemoShots()
  const checkpoints = await CheckpointLog.open()
  // 先挂 MCP：工具注册表是在建会话时一次性造出来的，挂晚了远端工具就进不了那张表
  const booted = await bootMcp(out)
  // 先扫技能：阶段一摘要拼在系统提示里，而系统提示是在建会话时一次性写进去的
  const scanned = await scanAllSkills()
  for (const problem of scanned.problems) out(`[skills] ⚠ 没装上：${problem}`)
  // 本天新增：任务表与进度接收端也要在建会话之前，理由和上面两条一样——
  // run_background 是在 createRegistry 里一次性注册的
  const tasks = await bootTasks(REPO_DIR, out)
  const session = await openSession(out, options, {
    ask,
    checkpoints,
    ...(booted.mount ? { mcp: booted.mount } : {}),
    skills: { ...scanned, pinned: [] },
    tasks: tasks.state,
  })
  await runLifecycle(session.hooks, 'session_start', REPO_DIR)

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
      `/mcp 看来源），${scanned.skills.length} 个技能（/skills 看开销）。输入 /help 看命令，/sessions 看会话，` +
      `/fork 看分叉点，跑到一半按 Esc 可以打断这一轮，/exit 退出。`
  )

  // 本天新增：通知队列接到这个终端上。idle 由下面的主循环维护
  let idle = false
  tasks.state.notices.attach({
    out,
    redraw: () => rl.prompt(true),
    canInterrupt: () => idle && rl.line === '',
  })

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
    // 攒着的通知在提示符重新出现之前倒出来——这是第二个安全时刻
    if (tasks.state.notices.size > 0) tasks.state.notices.flush(out)
    idle = true
    const raw = await lines.next()
    idle = false
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
  // 收摊前先跑一次会话结束钩子：它会告诉用户「还有几个后台任务会被杀掉」
  await runLifecycle(session.hooks, 'session_end', REPO_DIR)
  // 子进程不会跟着父进程一起死，不收摊就会在机器上留一串孤儿 server 与后台任务
  await shutdownMcp(booted)
  await shutdownTasks(tasks)
  // D20 新增：/panel 起过面板的话，不关它进程就不会退出，端口 3120 也一直被占着
  await shutdownPanel()
}
