import { Annotation, END, START, Send, StateGraph } from '@langchain/langgraph'
import { concatWorkspace, duplicateIds, latestById, upsertWorkspace } from './shared/reducers'
import type { AgentState, Attachment, Message, Task } from './shared/state'
import { preview } from './shared/state'
import {
  baseGoal,
  degrade,
  EXECUTOR_CONCURRENCY,
  MAX_REVIEW_ROUNDS,
  planTasks,
  reviewTasks,
  runTask,
} from './shared/roles'

// ---------------------------------------------------------------------------
// 一、图状态。字段与 D15 定稿的 AgentState 完全一致，今天只换一样东西：
// workspace 这条通道的 reducer。两种模式跑的是同一份节点代码，差别只在这一行——
// 这正是本章要你亲眼看见的对比。
// ---------------------------------------------------------------------------

export type ReducerMode = 'concat' | 'upsert'

const replace = <T>(): { reducer: (_old: T, next: T) => T } => ({ reducer: (_old, next) => next })

export function makeAnnotation(mode: ReducerMode) {
  return Annotation.Root({
    messages: Annotation<Message[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
    route: Annotation<string | undefined>,
    routingReason: Annotation<string | undefined>,
    workspace: Annotation<Task[]>({
      reducer: mode === 'concat' ? concatWorkspace : upsertWorkspace,
      default: () => [],
    }),
    reviewRounds: Annotation<number>({ ...replace<number>(), default: () => 0 }),
    summary: Annotation<string | undefined>,
    attachments: Annotation<Attachment[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
    degraded: Annotation<boolean>({ ...replace<boolean>(), default: () => false }),
  })
}

export type GraphState = ReturnType<typeof makeAnnotation>['State']

/** 编译期断言：图状态与 D15 定稿的 AgentState 一一对应，改坏了这里立刻红。 */
const _sameShape: AgentState = null as unknown as GraphState
void _sameShape

/** 一个 Executor 实例只收一件活：Send 把子任务当参数塞给它，而不是让它自己去状态里挑。 */
type ExecutorInput = GraphState & { task: Task }

/** 只为看得见并行度：记录同一时刻在跑的 Executor 峰值。生产里这个数字来自链路追踪。 */
let inFlight = 0
let peakInFlight = 0

export function resetConcurrencyProbe(): void {
  inFlight = 0
  peakInFlight = 0
}

export function peakConcurrency(): number {
  return peakInFlight
}

// ---------------------------------------------------------------------------
// 二、四个节点。每个节点仍然只做一件事：读全量状态，返回一个只含改动字段的增量。
// 区别是从今天起，同一个字段会被好几个节点实例在同一轮里一起写。
// ---------------------------------------------------------------------------

/** Planner：把一句请求拆成 1–3 件可以并行做的子任务，写进共享工作区。 */
export async function plannerNode(state: GraphState): Promise<Partial<GraphState>> {
  const last = state.messages.at(-1)
  const request = last && typeof last.content === 'string' ? last.content : ''
  return { workspace: await planTasks(request) }
}

/** Executor：做完手上这一件。异常在这里被翻译成状态——节点边界是最后一道防线。 */
export async function executorNode(state: ExecutorInput): Promise<Partial<GraphState>> {
  const task = state.task
  inFlight += 1
  peakInFlight = Math.max(peakInFlight, inFlight)
  // 练习 4：把这次执行包进 try / catch / finally。
  //   catch 里不要让异常冒泡：用 degrade(task, task.toolCalls, [], 原因) 把它变成一条 failed 记录，
  //   同时置 degraded = true；inFlight 的减一要放进 finally，否则抛错时并发计数只增不减。
  // 提示：Send 扇出的每个 Executor 都是图里的一个节点，任何一个节点抛错都会让整张图 reject，
  //       另外两件已经做完的活跟着一起丢。并行的第一课就是「失败要被关在一个子任务里」。
  // 挖空默认：不接异常。跑一次自检你会看到理赔服务 503 把整张图一起带走了。
  const done = await runTask(task)
  inFlight -= 1
  // 只在真降级时才写 degraded：没改的字段一个都不要往增量里放，否则会覆盖别人写的值
  return done.status === 'failed' ? { workspace: [done], degraded: true } : { workspace: [done] }
}

/** Critic：逐条评审做完的活，不合格就打回——但打回次数有上限，到顶就降级放行。 */
export async function criticNode(state: GraphState): Promise<Partial<GraphState>> {
  const tasks = latestById(state.workspace)
  // 练习 3：让 Critic 真的评审并打回，同时自己给回路设一个上限。
  //   a) 用 reviewTasks(...) 评审 status 是 done 的子任务，拿到每条的合格与否和**具体理由**
  //   b) 有不合格、且 state.reviewRounds 小于 MAX_REVIEW_ROUNDS：把它们改回 pending、
  //      用 `${baseGoal(t.goal)} ｜ 评审意见：${r.reason}` 写进 goal，并把 reviewRounds 加一
  //   c) 上限用完还不合格：不要再打回，把它们标成 failed 并置 degraded = true——
  //      降级返回已有结果，不抛错
  // 提示：漏掉 b 里的上限判断，图会在 critic 与 executor 之间无限打转，最后撞上 LangGraph
  //       自带的 recursionLimit 抛 GraphRecursionError。那道保险丝是全图的、不是你的业务上限，
  //       触发时你连已有结果都拿不到——所以业务上限必须自己设。
  // 挖空默认：从不打回。跑一次自检你会看到少了「退款结论」的退款方案也照样放行。
  void tasks
  void reviewTasks
  void MAX_REVIEW_ROUNDS
  void baseGoal
  return {}
}

/** 汇总：把工作区里所有拿到结果的活合成一条回复，降级的也照样带上。 */
export function respondNode(state: GraphState): Partial<GraphState> {
  const tasks = latestById(state.workspace)
  const lines = tasks
    .filter((t) => t.result)
    .map((t) => `${t.status === 'done' ? '·' : '·（未达标）'} ${t.result}`)
  const text = lines.length > 0 ? lines.join('\n') : '这次没有产出可用的结果。'
  return {
    messages: [{ role: 'assistant', content: text }],
    degraded: tasks.some((t) => t.status !== 'done'),
  }
}

// ---------------------------------------------------------------------------
// 三、接线。今天多了两条 D15 没有的边：
//   planner → 若干个 executor（扇出，条数在运行时才知道，靠 Send）
//   critic  → executor（回边，只把没过的那几条重新派出去）
// ---------------------------------------------------------------------------

/** 扇出：有几件 pending 就派几个 Executor。返回的是一串 Send，不是节点名。 */
function fanOut(state: GraphState): Send[] | typeof END {
  const pending = latestById(state.workspace).filter((t) => t.status === 'pending')
  if (pending.length === 0) return END
  return pending.map((task) => new Send('executor', { task }))
}

/** 评审之后：还有被打回的就重新扇出，没有就去汇总。 */
function afterCritic(state: GraphState): Send[] | 'respond' {
  const pending = latestById(state.workspace).filter((t) => t.status === 'pending')
  if (pending.length === 0) return 'respond'
  return pending.map((task) => new Send('executor', { task }))
}

export function buildGraph(mode: ReducerMode) {
  return new StateGraph(makeAnnotation(mode))
    .addNode('planner', plannerNode)
    .addNode('executor', executorNode)
    .addNode('critic', criticNode)
    .addNode('respond', respondNode)
    .addEdge(START, 'planner')
    .addConditionalEdges('planner', fanOut, ['executor', END])
    .addEdge('executor', 'critic')
    .addConditionalEdges('critic', afterCritic, ['executor', 'respond'])
    .addEdge('respond', END)
    .compile()
}

// ---------------------------------------------------------------------------
// 四、跑一次并把过程录下来。多 Agent 的 bug 九成是「某个字段在某一步被谁写坏了」，
// 所以 trace 记的是「哪个节点写了哪几个字段」，而不是最终状态。
// ---------------------------------------------------------------------------

export interface TraceStep {
  node: string
  changed: string[]
  detail: string
}

export interface RunResult {
  final: GraphState
  trace: TraceStep[]
  /** 同时在跑的 Executor 峰值，用来验证并发上限真的生效了 */
  peak: number
  /** 工作区里重复的 id——concat reducer 下会非空 */
  duplicates: string[]
}

export async function runGraph(request: string, mode: ReducerMode = 'upsert'): Promise<RunResult> {
  resetConcurrencyProbe()
  const graph = buildGraph(mode)
  const input = { messages: [{ role: 'user', content: request } as Message] }

  const trace: TraceStep[] = []
  let final = {} as GraphState
  // maxConcurrency 是全图的并发上限：没有它，Planner 拆出 20 件活就会一次打出 20 个模型请求。
  const stream = await graph.stream(input, {
    streamMode: ['updates', 'values'],
    maxConcurrency: EXECUTOR_CONCURRENCY,
  })
  for await (const [mode_, chunk] of stream as AsyncIterable<[string, unknown]>) {
    if (mode_ === 'values') {
      final = chunk as GraphState
      continue
    }
    for (const [node, update] of Object.entries(chunk as Record<string, Partial<GraphState>>)) {
      trace.push({ node, changed: Object.keys(update), detail: describe(update) })
    }
  }
  return { final, trace, peak: peakConcurrency(), duplicates: duplicateIds(final.workspace) }
}

function describe(update: Partial<GraphState>): string {
  const bits: string[] = []
  if (update.workspace) {
    bits.push(update.workspace.map((t) => `${t.id}:${t.status}/${t.toolCalls}次`).join(' '))
  }
  if (update.reviewRounds !== undefined) bits.push(`打回轮次=${update.reviewRounds}`)
  if (update.messages)
    bits.push(update.messages.map((m) => preview(m).replace(/\n/g, ' ')).join(' / '))
  if (update.degraded !== undefined) bits.push(`degraded=${update.degraded}`)
  return bits.join('｜') || '(无改动，评审全部通过)'
}
