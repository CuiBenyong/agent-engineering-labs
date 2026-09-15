/**
 * 一轮对话的流水线。来自 D19，本天只改了一处：包装链最外侧多了一层可选的 meterTurn，
 * 用来给评估记 usage。没传 meter 时这一层根本不存在，REPL 那条路径与前十九天完全一致。
 *
 * 原 D19 说明：在中间多了一步：**图片附件的解析、能力探测与降级**。
 *
 * 它插在技能之后、@ 引用之前，这个位置只有一条理由，但那条理由是硬的：
 * `@work/shots/ui.png` 在第八天那套语法里是一个普通的文件引用，展开出来会是一坨乱码。
 * 所以图片必须先把自己那几条引用摘走、并在原文里转义掉，@ 那一层才不会去碰它们。
 *
 * 原 D18 说明：在两端各加了一件事，都和后台任务有关：
 *   开头  把「上一轮之后完成的后台任务」以一条 user 消息告诉模型
 *   结尾  把攒着的通知倒到终端上（这里是一个安全时刻：这一轮的输出已经结束了）
 *
 * **钩子没有出现在这个文件里**，这是 D18 的一个结论而不是遗漏：钩子是套在
 * ToolDef 外面的一层装饰（hooks/wrap.ts），工具一执行它自己就跑了，
 * 流水线不需要知道有这么个东西。
 *
 * 原 D16 说明：在最前面多了一步：**技能的触发判定与阶段二注入**。
 *
 * 它排在压缩之后、@ 引用之前，顺序是想过的：
 *   - 排在压缩之后，是因为压缩处理的是**旧**上下文，而技能块属于这一轮的新内容，
 *     刚注入就被压掉是最没道理的一种压缩；
 *   - 排在 @ 引用之前，是因为它们的关系是「先给规矩，再给材料」——
 *     模型读到 src/calc.js 的内容时，那份「除零要抛错」的约定应该已经在它眼前了。
 *
 * 点名用完就清：/skill 是一个手动的一次性开关，常驻的东西已经由阶段一负责了。
 *
 * 原 D15 说明：本天在包装链里再加一层 watchSnapshots（拍文件快照）。
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
 *   0. 先把「上一轮之后完成的后台任务」以一条 user 消息告诉模型（D18 定的，
 *      它必须排在压缩之前：这是一条新消息，刚塞进去就被压掉是最没道理的一种压缩）。
 *   1. 再压缩旧上下文（如果超了触发线）——**压的是旧的，不是这一句**。
 *      反过来做的话，用户刚贴进来的资料会被立刻压成摘要，那是最没道理的一种压缩。
 *   2. 技能的触发判定与阶段二注入（D16 定的）
 *   3. 先把图片附件摘出来（本天新增）——顺序反了 .png 会被当文本读
 *   4. 再解析这一句里的 @ 引用，注入一条、原话一条（D8 定的）
 *   5. 记下这一轮的输入文本快照，交给取样器和 usage 配对（校准用）
 *   6. 跑循环，路过时落盘（D7）、取样（D12）、渲染
 *   7. 收尾时用攒到的样本校准一次系数
 *   8. 打计划核对表（D13）
 *   9. 最后把攒着的后台通知倒到终端上（D18）
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
import { matchSkills, formatHits } from './skills/trigger.js'
// D19 接线（1/3）：图片附件的解析、组装与降级
import { attachImages, buildContent, buildDegraded, type VisionAttach } from './vision/attach.js'
import { describeVision, ensureVision, willSendImages } from './vision/capability.js'
// D20 接线：包装链最外侧的用量计量
import { meterTurn, type UsageMeter } from './evals/meter.js'
import {
  stage1Summary,
  stage2Bodies,
  fullLoadCost,
  savingLine,
  formatDecisions,
} from './skills/inject.js'

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
export async function pushUserTurn(
  session: Session,
  line: string,
  shot?: VisionAttach
): Promise<string[]> {
  // D19 接线（2/3）：图片这条路必须排在 @ 展开之前。
  // 反过来的话，一个 .png 会被第八天那套「把文件贴进来」当成文本读，注入一坨乱码。
  const attached = shot ?? (await attachImages(line, { roots: referenceRoots() }))
  const injection = await buildInjection(attached.maskedLine, { roots: referenceRoots() })
  if (injection.message) session.messages.push(injection.message)

  const text = userTextForModel(attached.maskedLine)
  const images = attached.attachments.filter((a) => a.base64)
  session.messages.push(
    images.length === 0
      ? { role: 'user', content: text }
      : willSendImages(session.vision)
        ? { role: 'user', content: buildContent(text, attached.attachments) }
        : { role: 'user', content: buildDegraded(text, attached.attachments) }
  )
  return [...injection.report, ...attached.report]
}

/**
 * 技能这一步：判定 → 决定 → 注入 → 报账。返回要打在终端上的几行。本天新增。
 *
 * **四行报账一行都不能省。** 技能是一段会悄悄改变模型行为的文字，
 * 用户必须能看见此刻有哪几段在场、哪几段被挡下了、为什么，以及这一轮花了多少。
 * 少了最后那一行，渐进披露就成了一句口号——你根本不知道它省没省下东西。
 */
export async function pushSkills(session: Session, line: string): Promise<string[]> {
  const state = session.skills
  if (state.skills.length === 0) return []

  const hits = matchSkills(state.skills, { text: line, pinned: state.pinned })
  const stage2 = await stage2Bodies(hits)
  if (stage2.message) session.messages.push(stage2.message)
  // 点名只对这一轮有效，用完就清
  state.pinned = []

  const stage1 = stage1Summary(state.skills)
  const full = await fullLoadCost(state.skills)
  return [
    ...formatHits(hits),
    ...formatDecisions(stage2.decisions),
    savingLine({
      fullChars: full.chars,
      fullTokens: full.tokens,
      stage1Tokens: stage1.tokens,
      stage2Tokens: stage2.tokens,
    }),
  ]
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
  /** D20 新增：传进来就在包装链上多一层计量。不传时这一层根本不存在 */
  meter?: UsageMeter
}

export interface TurnOutcome {
  summary: RenderSummary
  compaction: CompactResult | null
  /** 这一轮跑完之后拿已批准的计划核对的结果。没有批准过计划就是 null */
  reconciliation: Reconciliation | null
}

export async function runTurn(options: TurnOptions): Promise<TurnOutcome> {
  const { session, provider, line, out } = options

  // 0. 后台任务的最新状态先告诉模型。**它必须排在压缩之前**：这是一条新消息，
  //    刚塞进去就被当成旧上下文压掉是最没道理的一种压缩（和技能块同一条理由）
  const notices = session.tasks.notices.drainForModel()
  if (notices) session.messages.push({ role: 'user', content: notices })

  // 1. 先压旧上下文
  const compaction = await maybeCompact(provider, session.messages, options.compaction ?? {})
  for (const row of compaction?.report ?? []) out(row)

  // 2. 技能：先判定命中，再按预算与领域互斥决定展开哪几份全文
  for (const row of await pushSkills(session, line)) out(row)

  // 3. D19 接线（3/3）：图片附件。**有图才去探能力**——没图的轮次一次请求都不该多花
  const shot = await attachImages(line, { roots: referenceRoots() })
  if (shot.attachments.some((a) => a.base64)) {
    await ensureVision(provider, session.vision)
    out(`（${describeVision(session.vision)}）`)
  }

  // 4. @ 引用注入与用户消息（带图时这条消息的 content 是数组）
  for (const row of await pushUserTurn(session, line, shot)) out(row)
  out('mca >')

  // 5. 这一轮的输入快照。注意要在跑之前取：跑起来之后数组就长了，配不上同一个 usage
  const promptText = promptTextOf(session.messages)

  // 6. 六层透明包装，从里到外：循环 → 拍快照 → 采集改动 → 落盘 → 取样 → 计量 → 渲染
  //    「拍快照」排在最里面不是随意的：生成器在 yield 处挂住，所以这一层拿到
  //    tool_start 时循环还没恢复执行，工具也就还没动手——「改之前」那张快照才是真的
  //    最外侧的「计量」是 D20 加的第六层，它和里面那几层一样透明：没传 meter
  //    就把事件原样让过去，于是 REPL 那条路径与前十九天完全一致
  const summary = await renderTurn(
    meterTurn(
      options.meter,
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
      )
    ),
    options.write,
    options.tty === undefined ? {} : { tty: options.tty }
  )

  // 7. 用真实用量校准估算器
  for (const row of applyCalibration(session.calibrator)) out(`（${row}）`)

  // 8. 有已批准的计划、而且这一轮真的动过东西，就把核对表打出来。
  //    没动过东西时不打：那会在每一轮都刷一屏「计划里的文件没被改动」的警告
  const plan = session.plan.approved
  const acted = session.plan.writes.length > 0 || session.plan.commands.length > 0
  let reconciliation: Reconciliation | null = null
  if (plan && acted) {
    reconciliation = reconcile(plan, session.plan)
    for (const row of formatReconcile(reconciliation)) out(row)
  }

  // 9. 这一轮的输出已经结束，现在是插话的安全时刻：把攒着的后台通知倒出来
  session.tasks.notices.flush(out)

  return { summary, compaction, reconciliation }
}
