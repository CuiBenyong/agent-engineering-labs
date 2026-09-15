/**
 * 一轮对话的流水线。来自 D13，本天在包装链里再加一层 watchSnapshots（拍文件快照）。
 *
 * 原 D13 说明：本天在包装链里加了一层 watchChanges，
 * 并在一轮结束时顺手打一遍计划核对表。
 *
 * 注意这一层的位置：**它套在 run 外面、落盘里面**，与 D7 的 recordTurn、
 * D12 的 sampleUsage 同一个形状——把事件原样传下去，路过时记一笔。
 * 三层包装谁在里谁在外不影响结果（每一层都只读不改事件），但顺序还是按
 * 「离循环越近的越靠里」排，读起来才和数据流一致。
 *
 * 原 D12 说明：本天从 repl.ts 拆出来。
 *
 * 为什么拆：D8 的 repl.ts 已经 303 行（本课单文件上限 350），而今天要在「跑一轮」
 * 这件事上再叠两层——压缩判定与用量取样。**输入循环与一轮对话是两件事**：
 * 前者管按键、命令与提示符，后者管「一句话进来之后依次发生什么」。
 * 拆开之后自检也能直接跑同一条流水线，不用在自检里另拼一遍。
 *
 * 一轮的顺序（顺序本身就是今天的教学点）：
 *
 *   1. 先压缩旧上下文（如果超了触发线）——**压的是旧的，不是这一句**。
 *      反过来做的话，用户刚贴进来的资料会被立刻压成摘要，那是最没道理的一种压缩。
 *   2. 再解析这一句里的 @ 引用，注入一条、原话一条（D8 定的）
 *   3. 记下这一轮的输入文本快照，交给取样器和 usage 配对（校准用）
 *   4. 跑循环，路过时落盘（D7）、取样（今天）、渲染
 *   5. 收尾时用攒到的样本校准一次系数
 */
import type { ChatProvider } from './providers/types.js'
import type { RenderSummary } from './render.js'
import type { Approver } from './kernel/approval.js'
import type { Session } from './session-factory.js'
import type { CompactOptions, CompactResult } from './context/compact.js'
import type { Root } from './refs/expand.js'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { recordTurn } from './session/record.js'
import { buildInjection, userTextForModel } from './refs/inject.js'
import { REPO_DIR } from './seed.js'
import { maybeCompact } from './context/compact.js'
import { applyCalibration, promptTextOf, sampleUsage } from './context/tokens.js'
import { persistRules } from './commands.js'
import { formatReconcile, reconcile, watchChanges, type Reconciliation } from './plan/check.js'
import { watchSnapshots } from './snapshot/capture.js'

/**
 * 引用解析的两个根，按顺序找。来自 D8，本天不改。
 *
 * 为什么是两个：用户心里的「这个文件」可能相对沙盒仓库（他正在让 Agent 改的那个仓库），
 * 也可能相对他启动 mca 的目录。两处都找，但**必须把实际解析到哪个根打出来**。
 */
export function referenceRoots(): Root[] {
  return [
    { name: 'work/repo', dir: REPO_DIR },
    { name: '当前目录', dir: process.cwd() },
  ]
}

/**
 * 把一句用户输入变成消息数组里的**两条**消息，返回要打在终端上的报账。来自 D8，本天不改。
 */
export async function pushUserTurn(session: Session, line: string): Promise<string[]> {
  const injection = await buildInjection(line, { roots: referenceRoots() })
  if (injection.message) session.messages.push(injection.message)
  session.messages.push({ role: 'user', content: userTextForModel(line) })
  return injection.report
}

export interface TurnOptions {
  session: Session
  provider: ChatProvider
  line: string
  write(chunk: string): void
  out(line: string): void
  signal?: AbortSignal
  approve?: Approver
  compaction?: Partial<CompactOptions>
  tty?: boolean
}

export interface TurnOutcome {
  summary: RenderSummary
  compaction: CompactResult | null
  /** 这一轮跑完之后拿已批准的计划核对的结果。没有批准过计划就是 null */
  reconciliation: Reconciliation | null
}

export async function runTurn(options: TurnOptions): Promise<TurnOutcome> {
  const { session, provider, line, out } = options

  // 1. 先压旧上下文
  const compaction = await maybeCompact(provider, session.messages, options.compaction ?? {})
  for (const row of compaction?.report ?? []) out(row)

  // 2. @ 引用注入
  for (const row of await pushUserTurn(session, line)) out(row)
  out('mca >')

  // 3. 这一轮的输入快照。注意要在跑之前取：跑起来之后数组就长了，配不上同一个 usage
  const promptText = promptTextOf(session.messages)

  // 4. 五层透明包装，从里到外：循环 → 拍快照 → 采集改动 → 落盘 → 取样 → 渲染
  //    「拍快照」排在最里面不是随意的：生成器在 yield 处挂住，所以这一层拿到
  //    tool_start 时循环还没恢复执行，工具也就还没动手——「改之前」那张快照才是真的
  const summary = await renderTurn(
    sampleUsage(
      session.calibrator,
      promptText,
      recordTurn(
        session.log,
        session.messages,
        watchChanges(
          session.plan,
          watchSnapshots(
            session.checkpoints,
            REPO_DIR,
            run({
              provider,
              registry: session.registry,
              messages: session.messages,
              cwd: REPO_DIR,
              ...(options.signal ? { signal: options.signal } : {}),
              gate: {
                state: session.permissions,
                ...(options.approve ? { approve: options.approve } : {}),
                persist: persistRules,
                log: out,
              },
            })
          )
        )
      )
    ),
    options.write,
    options.tty === undefined ? {} : { tty: options.tty }
  )

  // 5. 用真实用量校准估算器
  for (const row of applyCalibration(session.calibrator)) out(`（${row}）`)

  // 6. 有已批准的计划、而且这一轮真的动过东西，就把核对表打出来。
  //    没动过东西时不打：那会在每一轮都刷一屏「计划里的文件没被改动」的警告
  const plan = session.plan.approved
  const acted = session.plan.writes.length > 0 || session.plan.commands.length > 0
  let reconciliation: Reconciliation | null = null
  if (plan && acted) {
    reconciliation = reconcile(plan, session.plan)
    for (const row of formatReconcile(reconciliation)) out(row)
  }

  return { summary, compaction, reconciliation }
}
