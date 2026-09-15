/**
 * REPL：读一行、判断是命令还是对话、执行、打印。来自 D8，本天改了三处：
 *   1. 启动顺序变了：先生成沙盒仓库与三层指令文件，再加载并合并指令，最后才开会话——
 *      因为会话的第一条 system 消息就是合并出来的那段 prompt
 *   2. openSession 收一个 instructions 参数
 *   3. **恢复会话时，system prompt 用当下重新加载的那一段，不用日志里那一段旧的**
 *
 * 第三条是今天定下的口径，值得说清楚：日志恢复的是「说过的话」，指令文件是「现在的规矩」。
 * 你昨天改了项目指令，今天 --resume 接上一条老会话，生效的必须是新规矩——
 * 否则同一个仓库里两条会话会按两套规矩干活，而这件事从终端上完全看不出来。
 * 第七天那句「恢复不是记住，是把历史搬回来」在今天多了一条边界：**规矩不属于历史。**
 *
 * 原 D8 说明：本天改了一处：
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
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { stdin, stdout } from 'node:process'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { createProvider } from './providers/index.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { COMMANDS, newSession, parseCommand, persistRules, replaceHistory } from './commands.js'
import type { ApprovalAnswer, ApprovalRequest } from './kernel/approval.js'
import {
  LineQueue,
  formatApprovalPrompt,
  isCancelKey,
  parseApprovalAnswer,
  type KeyInfo,
} from './input.js'
import type { CliOptions } from './cli.js'
import { SessionLog, latestSessionId, listSessions } from './session/log.js'
import { recordTurn } from './session/record.js'
import { replay } from './session/replay.js'
import { buildInjection, userTextForModel } from './refs/inject.js'
import { formatContext, instructionSources, loadInstructions } from './instructions/index.js'
import { seedInstructions } from './instructions/fixtures.js'
import { BASE_PROMPT } from './commands.js'
import type { LoadResult } from './instructions/index.js'
import type { Root } from './refs/expand.js'
import type { Session } from './commands.js'

export type { Command, Session } from './commands.js'
export { LineQueue, isCancelKey, formatApprovalPrompt, parseApprovalAnswer } from './input.js'
export type { KeyInfo } from './input.js'

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
  options: CliOptions,
  instructions?: LoadResult
): Promise<Session> {
  if (!options.resume) return newSession(out, await SessionLog.create(), instructions)

  const id = options.resume === true ? await latestSessionId() : options.resume
  if (!id) {
    out('没有可恢复的会话，开一条新的。')
    return newSession(out, await SessionLog.create(), instructions)
  }

  const { log, read } = await SessionLog.open(id)
  const restored = replay(read.events)
  const session = newSession(out, log, instructions)
  if (restored.messages.length > 0) {
    replaceHistory(session.messages, restored.messages)
    // 规矩不属于历史：把重放出来的那条旧 system 消息换成本次加载的
    const fresh = instructions?.prompt ?? BASE_PROMPT
    if (session.messages[0]?.role === 'system') {
      const stale = session.messages[0].content !== fresh
      session.messages[0] = { role: 'system', content: fresh }
      if (stale) out('（指令文件自上次以来有变化，已按当前的指令重新拼了 system prompt）')
    } else {
      session.messages.unshift({ role: 'system', content: fresh })
    }
  }
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
  if (injection.message) session.messages.push(injection.message)
  session.messages.push({ role: 'user', content: userTextForModel(line) })
  return injection.report
}

/** 沙盒仓库不存在才生成。理由见 startRepl 里那段注释 */
export async function ensureRepo(): Promise<void> {
  const already = await fs
    .stat(path.join(REPO_DIR, 'package.json'))
    .then(() => true)
    .catch(() => false)
  if (!already) await seedRepo()
}

export async function startRepl(options: CliOptions = {}): Promise<void> {
  const write = (chunk: string) => void stdout.write(chunk)
  const out = (line: string) => write(`${line}\n`)
  // 顺序：仓库 → 指令文件 → 加载合并 → 开会话。seedRepo 会把 work/repo 整个重建，
  // 所以指令文件必须在它之后造，否则项目级与目录级那两份会被一起删掉。
  //
  // 本天还改了一件事：**启动时不再无条件重建沙盒仓库**。项目级与目录级指令文件
  // 就住在那个仓库里，无条件重建等于每次启动都把用户刚写的规矩删掉。
  // 改成「不存在才生成」，想回到干净起点用 /seed。
  await ensureRepo()
  await seedInstructions()
  const instructions = await loadInstructions({ ...instructionSources(), base: BASE_PROMPT })
  const session = await openSession(out, options, instructions)
  const provider = createProvider()

  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '你 > ' })
  const queue = new LineQueue()
  rl.on('line', (line) => queue.push(line))
  rl.on('close', () => queue.close())

  out(
    `mca 已启动（${provider.id} · ${provider.model}），会话 ${session.log.id}，` +
      `${session.registry.size} 个工具。输入 /help 看命令，/context 看指令来源，` +
      `/sessions 看会话，跑到一半按 Esc 可以打断这一轮，/exit 退出。`
  )
  // 启动时就把指令来源打出来：常驻的东西默认可见，比藏在一条命令后面好
  for (const row of formatContext(instructions.report)) out(row)

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
