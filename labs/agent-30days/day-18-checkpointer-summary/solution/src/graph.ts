import { Annotation, END, START, Send, StateGraph } from '@langchain/langgraph'
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from '@langchain/langgraph'
import type { RunnableConfig } from '@langchain/core/runnables'
import { callModel } from './infra/model'
import { buildSummaryUpdate, needsSummary } from './shared/summarize'
import type { AgentState, Attachment, Message, Task } from './shared/state'

// ---------------------------------------------------------------------------
// 一、图状态。字段与 D15 定稿的 AgentState 完全一致，今天只有 messages 这条通道换了写法：
// 它必须同时支持「追加一条」和「整份替换」——因为摘要节点做的是**减法**，
// 而 D15/D17 给它配的 concat reducer 只会让数组越来越长，永远压不短。
// ---------------------------------------------------------------------------

/** 通道的更新类型：数组是追加，`{ replace }` 是整份替换。 */
export type MessagesUpdate = Message[] | { replace: Message[] }

/**
 * 一条通道可以有两种类型：存进去的（Message[]）和写进来的（MessagesUpdate）。
 * 这不是取巧——LangChain 自己的消息通道也是这么干的，它认一种叫 RemoveMessage 的特殊消息
 * 来表达删除。**累加通道要想缩短，必须让 reducer 认识一个「替换」指令。**
 */
function messagesReducer(old: Message[], next: MessagesUpdate): Message[] {
  return Array.isArray(next) ? old.concat(next) : next.replace
}

const replace = <T>(): { reducer: (_old: T, next: T) => T } => ({ reducer: (_old, next) => next })

export const AgentAnnotation = Annotation.Root({
  messages: Annotation<Message[], MessagesUpdate>({
    reducer: messagesReducer,
    default: () => [],
  }),
  route: Annotation<string | undefined>,
  routingReason: Annotation<string | undefined>,
  workspace: Annotation<Task[]>({
    // D17 定的按 id 原地更新，原样沿用
    reducer: (old, next) => {
      const merged = old.slice()
      for (const task of next) {
        const at = merged.findIndex((t) => t.id === task.id)
        if (at === -1) merged.push(task)
        else merged[at] = task
      }
      return merged
    },
    default: () => [],
  }),
  reviewRounds: Annotation<number>({ ...replace<number>(), default: () => 0 }),
  summary: Annotation<string | undefined>,
  // 附件也是累加通道，但**没有任何节点会重写它**——摘要节点从头到尾不碰这个字段
  attachments: Annotation<Attachment[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  degraded: Annotation<boolean>({ ...replace<boolean>(), default: () => false }),
})

export type GraphState = typeof AgentAnnotation.State

/**
 * 节点返回的增量。它和 GraphState 只有一个字段不同：messages 这里是**写入类型**
 * （可以是 `{ replace }`），而 GraphState 里是**存储类型**（永远是 Message[]）。
 * 一条通道的这两种类型可以不一样，摘要节点能把历史压短全靠这个区别。
 */
export type Delta = Partial<Omit<GraphState, 'messages'>> & { messages?: MessagesUpdate }

/** 编译期断言：图状态与 D15 定稿的 AgentState 一一对应，改坏了这里立刻红。 */
const _sameShape: AgentState = null as unknown as GraphState
void _sameShape

/** 一个 Executor 实例只收一件活：Send 把子任务当参数塞给它。今天要验的正是这个参数怎么进检查点。 */
type ExecutorInput = GraphState & { task: Task }

/**
 * 人工干预项。D16 定的约定是 override **走 configurable，不进图状态**。
 * 今天正好能说清那条约定的理由：checkpointer 存的是图状态，
 * 把「这一次执行被人干预过」写进状态，它就会被检查点一起持久化；
 * 之后从这个检查点恢复、或者从它分叉，那个一次性的人工决定会被**当成历史重放一遍**，
 * 于是一条早该走正常流程的线，永远被改派到同一个地方。
 *
 * 判据：**这条信息说的是「这一次执行怎么跑」，还是「这个会话是什么」？**
 * 前者进 configurable，后者才进状态。
 */
export interface RunContext {
  overrideRoute?: string
}

// ---------------------------------------------------------------------------
// 二、节点
// ---------------------------------------------------------------------------

const SKILLS: [kind: string, pattern: string, goal: string][] = [
  ['order', '订单|状态|进度', '查订单状态并说明当前阶段'],
  ['shipping', '物流|快递|到哪|发货', '查物流轨迹并给出预计送达时间'],
  ['refund', '退款|退货|退钱', '依据规则拟一份退款方案，不执行退款'],
]

/**
 * 接单：判一次这单该谁接。人工改派从 config.configurable 进来，不从状态里读。
 * 落进状态的只有**判断结果**（route 是这个会话的事实），
 * 「这次被人干预过」这个开关一个字都不进状态，所以它不会被检查点带着重放。
 */
export function intakeNode(state: GraphState, config?: LangGraphRunnableConfig): Delta {
  const last = state.messages.at(-1)
  const request = last && typeof last.content === 'string' ? last.content : ''
  const context = (config?.configurable ?? {}) as RunContext
  const modelRoute = /退款|退货/.test(request) ? 'refund_draft' : 'order_lookup'
  const route = context.overrideRoute ?? modelRoute
  return {
    route,
    routingReason: context.overrideRoute
      ? `override:${route}｜模型原判 ${modelRoute}`
      : `模型判定 ${route}`,
  }
}

/**
 * 摘要节点。它只写两个字段：messages（整份换成保留下来的那几条）与 summary。
 *
 * **它一个字都不碰 attachments、也不碰 workspace。**
 * 附件存的是引用不是内容，把引用摘要掉等于把井道填了——设备再来就没地方装了；
 * workspace 是结构化数据，摘要成一句话之后 Critic 没法再逐条比对验收要求。
 * 摘要只该对「自然语言历史」动手，这是本章最需要记住的一条边界。
 */
export async function summarizeNode(state: GraphState): Promise<Delta> {
  const reason = needsSummary(state.messages)
  if (!reason) return {}
  const update = await buildSummaryUpdate(state.messages, state.summary, reason)
  if (!update) return {}
  return { messages: { replace: update.kept }, summary: update.summary }
}

/** 规划：拆成 1–3 件可以并行做的子任务。沿用 D17，今天不是重点。 */
export async function plannerNode(state: GraphState): Promise<Delta> {
  const last = state.messages.at(-1)
  const request = last && typeof last.content === 'string' ? last.content : ''
  const catalog = SKILLS.map(([kind, pattern, goal]) => `${kind} :: ${pattern} :: ${goal}`).join(
    '\n'
  )
  const raw = await callModel('plan', `用户请求：${request}\n可选子任务类型：\n${catalog}`)
  const orderId = request.match(/SO\d{8}/)?.[0] ?? 'SO20260901'
  const kinds = raw
    .split('\n')
    .map((k) => k.trim())
    .filter((k) => SKILLS.some(([kind]) => kind === k))
  const picked = kinds.length > 0 ? kinds.slice(0, 3) : ['order']
  return {
    workspace: picked.map((kind, i) => ({
      id: `t-${i + 1}-${kind}`,
      goal: `${SKILLS.find(([k]) => k === kind)?.[2]}（订单 ${orderId}）`,
      toolCalls: 0,
      status: 'pending' as const,
    })),
  }
}

/** 执行：把手上这一件做完。子任务是 Send 塞进来的参数，不是自己去状态里挑的。 */
export async function executorNode(state: ExecutorInput): Promise<Delta> {
  const task = state.task
  const observations = [
    `订单档案已读取（第 ${task.toolCalls + 1} 次工具调用）`,
    `目标：${task.goal}`,
  ]
  const text = await callModel(
    'compose',
    `子任务目标：${task.goal}\n工具观测：\n${observations.map((o) => `- ${o}`).join('\n')}`
  )
  return { workspace: [{ ...task, toolCalls: task.toolCalls + 1, result: text, status: 'done' }] }
}

/** 汇总：把工作区里所有结果合成一条回复，并把摘要作为背景一起交出去。 */
export function respondNode(state: GraphState): Delta {
  const lines = state.workspace.filter((t) => t.result).map((t) => `· ${t.result}`)
  const head = state.summary ? `（背景摘要）${state.summary}\n` : ''
  const files =
    state.attachments.length > 0
      ? `\n（随行附件 ${state.attachments.length} 件：${state.attachments.map((a) => a.ref).join('、')}）`
      : ''
  return { messages: [{ role: 'assistant', content: `${head}${lines.join('\n')}${files}` }] }
}

// ---------------------------------------------------------------------------
// 三、接线
// ---------------------------------------------------------------------------

/** 接单之后：历史超阈值就先去摘要，否则直接规划。判断结果要能在 trace 里看见。 */
function afterIntake(state: GraphState): 'summarize' | 'planner' {
  return needsSummary(state.messages) ? 'summarize' : 'planner'
}

/** 扇出：有几件 pending 就派几个 Executor，参数由 Send 携带。 */
function fanOut(state: GraphState): Send[] | typeof END {
  const pending = state.workspace.filter((t) => t.status === 'pending')
  if (pending.length === 0) return END
  return pending.map((task) => new Send('executor', { task }))
}

/** 图里的五个节点名。interruptBefore 只认这几个，写错了编译期就红。 */
export type NodeName = 'intake' | 'summarize' | 'planner' | 'executor' | 'respond'

export interface BuildOptions {
  checkpointer?: BaseCheckpointSaver
  /** 在哪个节点之前停下。自检拿它模拟「进程挂在半路」，生产里它是人工审批闸口。 */
  interruptBefore?: NodeName[]
}

export function buildGraph(options: BuildOptions = {}) {
  return new StateGraph(AgentAnnotation)
    .addNode('intake', intakeNode)
    .addNode('summarize', summarizeNode)
    .addNode('planner', plannerNode)
    .addNode('executor', executorNode)
    .addNode('respond', respondNode)
    .addEdge(START, 'intake')
    .addConditionalEdges('intake', afterIntake, ['summarize', 'planner'])
    .addEdge('summarize', 'planner')
    .addConditionalEdges('planner', fanOut, ['executor', END])
    .addEdge('executor', 'respond')
    .addEdge('respond', END)
    .compile({
      checkpointer: options.checkpointer,
      interruptBefore: options.interruptBefore,
    })
}

// ---------------------------------------------------------------------------
// 四、检查点的两种用法：恢复（接着往下跑）与分叉（回到中间某一步换条路走）
// ---------------------------------------------------------------------------

export type CompiledAgentGraph = ReturnType<typeof buildGraph>

/** 一条线的一个坐标。thread_id 定位「哪条会话」，checkpoint_id 定位「这条会话的哪一刻」。 */
export function threadConfig(threadId: string, checkpointId?: string): RunnableConfig {
  return { configurable: { thread_id: threadId, checkpoint_id: checkpointId } }
}

/**
 * 从检查点恢复一次没跑完的执行。
 *
 * **入口是 `invoke(null)`。** 状态已经在检查点里了，再把历史喂一遍不是恢复——
 * 那是在中断点上又追加了一次输入，历史会变成两份，而且这一次的写入还会盖在上面。
 * 第三个参数是中断那一次的原始输入，**故意留在签名里**：它就是你最容易想去用的东西，
 * 而正确答案是不用它。
 */
export async function resumeRun(
  graph: CompiledAgentGraph,
  config: RunnableConfig,
  originalInput: Delta
): Promise<GraphState> {
  void originalInput
  return (await graph.invoke(null, config)) as GraphState
}

/**
 * 从中间某个检查点分叉：同一条线、同一个 thread_id，但把 checkpoint_id 指回过去某一刻。
 *
 * 少写 checkpoint_id，这行代码就退化成「在这条线最新的状态上再追加一次输入」——
 * 它照样能跑完、照样不报错，只是你以为的「从第 2 步重来」其实是「在第 6 步后面接着写」。
 * 这是 checkpoint/replay 最常见的用错方式。
 */
export async function forkFrom(
  graph: CompiledAgentGraph,
  threadId: string,
  checkpointId: string,
  input: Delta
): Promise<GraphState> {
  return (await graph.invoke(input, threadConfig(threadId, checkpointId))) as GraphState
}
