import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import { callSubAgent, routeFreeText, routeStructured } from './infra/model'
import {
  FALLBACK_ROUTE,
  ROUTE_JSON_SCHEMA,
  SUB_AGENTS,
  resolveRoute,
  type SubAgent,
} from './shared/routing'
import type { AgentState, Attachment, Message, Task } from './shared/state'
import { preview } from './shared/state'

// ---------------------------------------------------------------------------
// 一、图状态：与 D15 完全同一份，一个字段都没加。
// 今天只是第一次真的往 route / routingReason 两个通道里写东西。
// 两个字段都是「后写覆盖」（不配 reducer 的默认行为）——一次执行只该有一个最终路由。
// ---------------------------------------------------------------------------

const replace = <T>(): { reducer: (_old: T, next: T) => T } => ({ reducer: (_old, next) => next })

export const AgentAnnotation = Annotation.Root({
  messages: Annotation<Message[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  // D16 写入：本章的正题
  route: Annotation<string | undefined>,
  routingReason: Annotation<string | undefined>,
  workspace: Annotation<Task[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  reviewRounds: Annotation<number>({ ...replace<number>(), default: () => 0 }),
  summary: Annotation<string | undefined>,
  attachments: Annotation<Attachment[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  degraded: Annotation<boolean>({ ...replace<boolean>(), default: () => false }),
})

/** 编译期断言：图状态的字段与 AgentState 一一对应，改坏了这里立刻红。 */
export type GraphState = typeof AgentAnnotation.State
const _sameShape: AgentState = null as unknown as GraphState
void _sameShape

const ORDER_ID = /SO\d{8}/

function lastUserText(state: GraphState): string {
  const last = state.messages.at(-1)
  return last && typeof last.content === 'string' ? last.content : ''
}

/**
 * override 从**运行时配置**进来，不进图状态。
 * 理由：它是「这一次执行被人干预了」，不是 Agent 自己的状态；
 * 混进状态里，D18 存检查点时会把一次性的人工决定当成历史一起恢复。
 */
function overrideFrom(config?: LangGraphRunnableConfig): string | undefined {
  const value = config?.configurable?.override
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// 二、Supervisor 节点：只判断这一单该谁接，不回答用户的问题。
// 它写两个字段：route（交给谁）和 routingReason（为什么）。少写第二个，事后就没法复盘。
// ---------------------------------------------------------------------------

export async function supervisorNode(
  state: GraphState,
  config?: LangGraphRunnableConfig
): Promise<Partial<GraphState>> {
  const text = lastUserText(state)

  // 练习 1：把下面这段「自由文本 + 正则捞名字」换成结构化输出。
  //   const raw = await routeStructured(text, ROUTE_JSON_SCHEMA)   // 返回 unknown
  //   const routed = resolveRoute(raw, overrideFrom(config))
  // 提示：先原样跑一次自检，看清自由文本路由是怎么**静默**失败的——
  // 模型明明判对了（「我觉得这个可以让查订单的同事看一下」），但它说的是人话不是 id，
  // 正则匹配不上就落进兜底，日志里只留下一句「smalltalk」，你根本看不出它其实判对了。
  // 另外注意这里的 0.5：自由文本给不出置信度，只能瞎填一个，于是阈值也就无从谈起。
  const reply = await routeFreeText(text)
  const guess = SUB_AGENTS.find((id) => reply.includes(id))
  const raw = { route: guess ?? FALLBACK_ROUTE, confidence: 0.5, routingReason: reply }
  const routed = resolveRoute(raw, overrideFrom(config))
  return { route: routed.route, routingReason: routed.routingReason }
}

// ---------------------------------------------------------------------------
// 三、三个子 Agent。它们共用一个工厂——差别只在人设与职责边界，
// 这正是拆 Agent 的意义：每个人设短、互不打架，改一个不会压掉另一个。
// ---------------------------------------------------------------------------

const SYSTEMS: Record<SubAgent, string> = {
  order_lookup: '你负责查订单状态与物流进度。只讲事实，不承诺时效，不谈退款政策。',
  refund_draft:
    '你负责按退款规则拟一份退款方案，只拟方案、不执行退款，也不做超出规则的承诺。结尾注明待人工复核。',
  smalltalk: '你负责闲聊与兜底。信息不足时先追问一句缺的关键信息（比如订单号），不要猜。',
}

function makeSubAgent(id: SubAgent) {
  return async function subAgentNode(state: GraphState): Promise<Partial<GraphState>> {
    const text = lastUserText(state)
    const orderId = text.match(ORDER_ID)?.[0]
    const answer = await callSubAgent(SYSTEMS[id], text, orderId)
    const task: Task = {
      id: `t-${state.workspace.length + 1}`,
      goal: `[${id}] ${text}`,
      result: answer,
      toolCalls: 1,
      status: 'done',
    }
    return { workspace: [task], messages: [{ role: 'assistant', content: answer }] }
  }
}

// ---------------------------------------------------------------------------
// 四、连边。D15 那三条边是编译期就定死的直线；今天 supervisor 之后的那条边
// 由 selectRoute 在运行时决定走向——这就是 Supervisor 模式的全部机械原理。
// ---------------------------------------------------------------------------

/**
 * 条件边的选择函数：只读状态、不调模型、不抛异常。
 * 判断在 supervisor 里已经做完了，这里只负责把结果翻译成一个节点名——
 * 把模型调用塞进这个函数会让「同一份状态每次跳到不同的节点」，图就没法复现了。
 */
export function selectRoute(state: GraphState): SubAgent {
  // 练习 4：把 supervisor 写进状态的 route 翻译成下一个节点名（没有值时用 FALLBACK_ROUTE）。
  // 提示：这个函数只读状态、不调模型、不抛异常——判断在 supervisor 里已经做完了。
  // 现在它无视 route，一律返回 order_lookup：supervisor 判了、routingReason 也写了，
  // 然后没有人用。「算了但没人用」是路由最隐蔽的一种坏法，日志上一切正常。
  void state
  return 'order_lookup'
}

export function buildGraph() {
  return (
    new StateGraph(AgentAnnotation)
      .addNode('supervisor', supervisorNode)
      .addNode('order_lookup', makeSubAgent('order_lookup'))
      .addNode('refund_draft', makeSubAgent('refund_draft'))
      .addNode('smalltalk', makeSubAgent('smalltalk'))
      .addEdge(START, 'supervisor')
      // 第三个参数是「选择函数的返回值 → 节点名」的映射表。
      // 写全它有两个好处：返回一个没登记的名字会在编译期报错，而且图可以被画出来。
      .addConditionalEdges('supervisor', selectRoute, {
        order_lookup: 'order_lookup',
        refund_draft: 'refund_draft',
        smalltalk: 'smalltalk',
      })
      .addEdge('order_lookup', END)
      .addEdge('refund_draft', END)
      .addEdge('smalltalk', END)
      .compile()
  )
}

export interface TraceStep {
  node: string
  changed: string[]
  detail: string
}

export interface RunResult {
  final: GraphState
  trace: TraceStep[]
}

/** 跑一次图，并逐节点记录状态变化。override 通过 configurable 传进去，不进状态。 */
export async function runGraph(question: string, override?: string): Promise<RunResult> {
  const graph = buildGraph()
  const input = { messages: [{ role: 'user', content: question } as Message] }
  const config = { configurable: { override } }

  const trace: TraceStep[] = []
  let final: GraphState | undefined
  // streamMode 传数组就能一次拿到两种流：updates 看每步增量，values 看每步之后的全量状态。
  // 最后一个 values 就是最终态，比 D15 那样再 invoke 一次省一半模型调用。
  for await (const [mode, chunk] of await graph.stream(input, {
    ...config,
    streamMode: ['updates', 'values'],
  })) {
    if (mode === 'updates') {
      for (const [node, update] of Object.entries(chunk as Record<string, Partial<GraphState>>)) {
        trace.push({ node, changed: Object.keys(update), detail: describe(update) })
      }
    } else {
      final = chunk as GraphState
    }
  }

  if (!final) throw new Error('图没有产出任何状态')
  return { final, trace }
}

function describe(update: Partial<GraphState>): string {
  const bits: string[] = []
  if (update.route) bits.push(`route=${update.route}`)
  if (update.routingReason) bits.push(update.routingReason)
  if (update.messages) bits.push(update.messages.map(preview).join(' / '))
  if (update.workspace) bits.push(update.workspace.map((t) => `${t.id}:${t.status}`).join(' '))
  return bits.join('｜') || '(无)'
}
