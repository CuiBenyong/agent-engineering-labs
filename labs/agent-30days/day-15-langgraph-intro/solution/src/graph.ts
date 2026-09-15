import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { callModel } from './infra/model'
import type { AgentState, Attachment, Message, Task } from './shared/state'
import { preview } from './shared/state'

// ---------------------------------------------------------------------------
// 一、把 AgentState 声明成图的状态。
// 每个字段是一条独立的通道（channel），通道自带一条合并规则（reducer）：
// 节点返回的是「这一步产生的增量」，通道决定这个增量怎么并进旧值。
// 不写 reducer 就是默认的「后写覆盖」。这一份 D16–D18 直接照抄。
// ---------------------------------------------------------------------------

const replace = <T>(): { reducer: (_old: T, next: T) => T } => ({ reducer: (_old, next) => next })

export const AgentAnnotation = Annotation.Root({
  // 累加：每个节点只返回自己新说的那几句，历史由通道拼起来
  messages: Annotation<Message[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  // D16 写入
  route: Annotation<string | undefined>,
  routingReason: Annotation<string | undefined>,
  // 累加：D17 的多个 Executor 会同时往里写，靠 concat 才不会互相覆盖
  workspace: Annotation<Task[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  // D17 写入
  reviewRounds: Annotation<number>({ ...replace<number>(), default: () => 0 }),
  // D18 写入
  summary: Annotation<string | undefined>,
  attachments: Annotation<Attachment[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  // D17 写入
  degraded: Annotation<boolean>({ ...replace<boolean>(), default: () => false }),
})

/** 编译期断言：图状态的字段与 AgentState 一一对应，改坏了这里立刻红。 */
export type GraphState = typeof AgentAnnotation.State
const _sameShape: AgentState = null as unknown as GraphState
void _sameShape

const SYSTEM = '你是一名电商客服助手。只回答与订单、物流、退款、发票有关的问题，答案要短。'
const ORDER_ID = /SO\d{8}/

// ---------------------------------------------------------------------------
// 二、三个节点。节点就是一个普通函数：读全量状态，返回一个「只含要改的字段」的对象。
// 不要在节点里原地修改 state——那样通道的 reducer 就被绕过去了，D18 的检查点也会对不上。
// ---------------------------------------------------------------------------

/** 入口节点：把这一轮的用户输入归一化成一条 user 消息，并抽出订单号。 */
export function intakeNode(state: GraphState): Partial<GraphState> {
  const last = state.messages.at(-1)
  const text = last && typeof last.content === 'string' ? last.content : ''
  const orderId = text.match(ORDER_ID)?.[0]
  // 注意这里只返回 workspace 一个字段：节点返回的是增量，没改的字段一个都不用写。
  // 系统提示词不进状态——它是 handle 调模型时的参数，进了状态就会被 D18 的摘要节点反复搬运。
  return {
    workspace: [
      {
        id: `t-${state.workspace.length + 1}`,
        goal: orderId ? `${text}（订单 ${orderId}）` : text,
        toolCalls: 0,
        status: 'pending',
      },
    ],
  }
}

/** 处理节点：调一次模型，把这件事做完。唯一会走网络的节点。 */
export async function handleNode(state: GraphState): Promise<Partial<GraphState>> {
  const task = state.workspace.at(-1)
  if (!task) return { degraded: true }
  const orderId = task.goal.match(ORDER_ID)?.[0]
  const reply = await callModel(SYSTEM, task.goal, orderId)
  // 通道是 concat，所以这里追加一条「同 id 的新版本」，respond 取最后一条为准。
  // 真正的「原地更新一条子任务」要等 D17 换成按 id 合并的 reducer。
  return {
    workspace: [{ ...task, result: reply.text, toolCalls: task.toolCalls + 1, status: 'done' }],
  }
}

/** 输出节点：把工作区里做完的活汇成一条给用户看的回复。 */
export function respondNode(state: GraphState): Partial<GraphState> {
  const done = state.workspace.filter((t) => t.status === 'done')
  const text = done.length > 0 ? done.map((t) => t.result).join('\n') : '这次没有产出可用的结果。'
  return { messages: [{ role: 'assistant', content: text }], degraded: done.length === 0 }
}

// ---------------------------------------------------------------------------
// 三、把节点连成图。今天这条链是**写死的直线**：三条边在编译期就定死了，
// 运行时不会变。真实客服要先判断「这一单该谁接」，那条边必须由模型在运行时决定——D16 的正题。
// ---------------------------------------------------------------------------

export function buildGraph() {
  return new StateGraph(AgentAnnotation)
    .addNode('intake', intakeNode)
    .addNode('handle', handleNode)
    .addNode('respond', respondNode)
    .addEdge(START, 'intake')
    .addEdge('intake', 'handle')
    .addEdge('handle', 'respond')
    .addEdge('respond', END)
    .compile()
}

export interface TraceStep {
  node: string
  /** 这一步改了哪几个字段——状态流动看的就是这个 */
  changed: string[]
  detail: string
}

/**
 * 跑一次图，并逐节点记录状态变化。
 * invoke 只给最终状态，看不到中间过程；streamMode: 'updates' 每个节点结束时吐一次增量，
 * 那份增量正好就是「这个节点写了什么」。调试多 Agent 的图基本全靠它。
 */
export async function runGraph(
  question: string
): Promise<{ final: GraphState; trace: TraceStep[] }> {
  const graph = buildGraph()
  const input = { messages: [{ role: 'user', content: question } as Message] }

  const trace: TraceStep[] = []
  for await (const chunk of await graph.stream(input, { streamMode: 'updates' })) {
    for (const [node, update] of Object.entries(chunk as Record<string, Partial<GraphState>>)) {
      const changed = Object.keys(update)
      trace.push({ node, changed, detail: describe(update) })
    }
  }
  // 同样的输入再跑一次拿最终态；生产里用 streamMode: ['updates', 'values'] 一次拿全
  const final = await graph.invoke(input)
  return { final, trace }
}

function describe(update: Partial<GraphState>): string {
  const bits: string[] = []
  if (update.messages) bits.push(update.messages.map(preview).join(' / '))
  if (update.workspace) {
    bits.push(update.workspace.map((t) => `${t.id}:${t.status}`).join(' '))
  }
  if (update.degraded !== undefined) bits.push(`degraded=${update.degraded}`)
  return bits.join('｜') || '(无)'
}
