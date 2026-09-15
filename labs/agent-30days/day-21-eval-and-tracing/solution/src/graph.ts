// 今天被评估的那套系统：D16 的 Supervisor + D17 的 Planner–Executor–Critic 拼在一起。
// 图本身这一周已经讲完了，本天一行新机制都不加，只做一件事——**给它埋上 trace**：
// 每个节点包一个 span，每次模型调用落一个子 span，一次请求于是有了完整的调用树。

import { Annotation, END, START, Send, StateGraph } from '@langchain/langgraph'
import { callModel } from './infra/model'
import { callTool, SKILLS, skillOf } from './infra/orders'
import { setActiveTracer, Tracer, withSpan, type Span } from './shared/observe'
import type { AgentState, Attachment, Message, Task } from './shared/state'

export const SUB_AGENTS = ['order_lookup', 'refund_draft', 'smalltalk'] as const
type SubAgent = (typeof SUB_AGENTS)[number]

export const CONFIDENCE_FLOOR = 0.6 // D16
export const TOOL_BUDGET = 5 // D17：子任务级，被打回重做也照样计费
export const MAX_REVIEW_ROUNDS = 2 // D17：最多打回 2 次，共 3 次执行
export const EXECUTOR_CONCURRENCY = 2 // D17：上限由配额决定，不是由机器性能决定
// 一、状态。字段与 D15 定稿的 AgentState 一一对应，一个都没加；
// messages 的写入类型仍然是 `Message[] | { replace }`（D18 扩的），复用这份图时照此。
export type MessagesUpdate = Message[] | { replace: Message[] }
const replace = <T>(): { reducer: (_old: T, next: T) => T } => ({ reducer: (_old, next) => next })

export const AgentAnnotation = Annotation.Root({
  messages: Annotation<Message[], MessagesUpdate>({
    reducer: (old, next) => (Array.isArray(next) ? old.concat(next) : next.replace),
    default: () => [],
  }),
  route: Annotation<string | undefined>,
  routingReason: Annotation<string | undefined>,
  workspace: Annotation<Task[]>({
    reducer: (old, next) => {
      const merged = old.slice() // D17 定的按 id 原地更新
      for (const t of next) {
        const at = merged.findIndex((x) => x.id === t.id)
        if (at === -1) merged.push(t)
        else merged[at] = t
      }
      return merged
    },
    default: () => [],
  }),
  reviewRounds: Annotation<number>({ ...replace<number>(), default: () => 0 }),
  summary: Annotation<string | undefined>,
  attachments: Annotation<Attachment[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  degraded: Annotation<boolean>({ ...replace<boolean>(), default: () => false }),
})

export type GraphState = typeof AgentAnnotation.State
export type Delta = Partial<Omit<GraphState, 'messages'>> & { messages?: MessagesUpdate }

/** 编译期断言：图状态与 D15 定稿的 AgentState 一一对应，改坏了这里立刻红。 */
const _sameShape: AgentState = null as unknown as GraphState
void _sameShape
const lastText = (s: GraphState): string => {
  const last = s.messages.at(-1)
  return last && typeof last.content === 'string' ? last.content : ''
}
const baseGoal = (goal: string): string => goal.split(' ｜ 评审意见：')[0]
const kindOf = (task: Task): string => task.id.replace(/^t-\d+-/, '')
// 二、五个节点。每个节点外面包一个 span——调用树的第一层就是「这一单走过哪几个角色」。
/** Supervisor：判这一单该谁接。置信度不够或路由名不在名单里，一律落 smalltalk（D16）。 */
export async function supervisorNode(state: GraphState): Promise<Delta> {
  return withSpan('supervisor', 'node', {}, async (span: Span) => {
    const raw = await callModel('route', `用户说：${lastText(state)}`)
    let route = 'smalltalk'
    let why = 'fallback:invalid-shape'
    try {
      const d = JSON.parse(raw) as { route: string; confidence: number; routingReason: string }
      const origin = `｜模型原判 ${d.route}：${d.routingReason}`
      if (!SUB_AGENTS.includes(d.route as SubAgent))
        why = `fallback:unknown-route(${d.route})${origin}`
      else if (d.confidence < CONFIDENCE_FLOOR)
        why = `fallback:low-confidence(${d.confidence})${origin}`
      else [route, why] = [d.route, d.routingReason]
    } catch {
      /* 解析失败就落上面那条 invalid-shape */
    }
    // 路由理由进 trace：线上答不上来「它当时走了哪条路」，就是因为少了这一行
    span.attrs.route = route
    span.attrs.routingReason = why
    return { route, routingReason: why }
  })
}

/** 兜底那位：不猜，追问缺的关键信息。 */
export async function smalltalkNode(state: GraphState): Promise<Delta> {
  return withSpan('smalltalk', 'node', {}, async () => {
    const content = await callModel('smalltalk', `用户说：${lastText(state)}`)
    return { messages: [{ role: 'assistant' as const, content }] }
  })
}

/** Planner：拆成 1–3 件可以并行做的子任务（D17）。 */
export async function plannerNode(state: GraphState): Promise<Delta> {
  return withSpan('planner', 'node', {}, async (span: Span) => {
    const request = lastText(state)
    const catalog = SKILLS.filter((s) => s.pattern)
      .map((s) => `${s.kind} :: ${s.pattern} :: ${s.goal}`)
      .join('\n')
    const raw = await callModel('plan', `用户请求：${request}\n可选子任务类型：\n${catalog}`)
    const orderId = request.match(/SO\d{8}/)?.[0] ?? 'SO20260901'
    const kinds = raw
      .split('\n')
      .map((k) => k.trim())
      .filter((k) => SKILLS.some((s) => s.kind === k))
      .slice(0, 3)
    const picked = kinds.length > 0 ? kinds : ['general']
    span.attrs.tasks = picked.join('+')
    const goalOf = (kind: string): string => `${skillOf(kind).goal}（订单 ${orderId}）`
    const pending = { toolCalls: 0, status: 'pending' as const }
    return {
      workspace: picked.map((k, i) => ({ id: `t-${i + 1}-${k}`, goal: goalOf(k), ...pending })),
    }
  })
}

const degrade = (task: Task, used: number, seen: string[], why: string): Task => ({
  ...task,
  toolCalls: used,
  result: `（降级）${why}。已有结果：${seen.join('；') || '什么都没查到'}`,
  status: 'failed',
})

/** Executor：做完手上这一件，预算耗尽或工具失败都走降级出口，绝不抛错（D17）。 */
export async function executorNode(state: GraphState & { task: Task }): Promise<Delta> {
  const task = state.task
  return withSpan('executor', 'node', { task: task.id }, async (span: Span) => {
    const skill = skillOf(kindOf(task))
    const orderId = task.goal.match(/SO\d{8}/)?.[0] ?? ''
    const seen: string[] = []
    let used = task.toolCalls
    try {
      for (const tool of skill.tools) {
        if (used >= TOOL_BUDGET) {
          span.attrs.outcome = 'budget'
          const why = `预算耗尽：停在「${tool}」之前`
          return { workspace: [degrade(task, used, seen, why)], degraded: true }
        }
        seen.push(await callTool(tool, orderId))
        used += 1
      }
    } catch (error) {
      span.attrs.outcome = 'tool-error'
      const why = error instanceof Error ? error.message : String(error)
      return { workspace: [degrade(task, used, seen, why)], degraded: true }
    }
    const observed = seen.map((o) => `- ${o}`).join('\n')
    const result = await callModel('compose', `子任务目标：${task.goal}\n工具观测：\n${observed}`)
    span.attrs.outcome = 'done'
    return { workspace: [{ ...task, toolCalls: used, result, status: 'done' as const }] }
  })
}

/** Critic：逐条按可核对的验收要求评审，打回带理由，上限到了就降级放行（D17）。 */
export async function criticNode(state: GraphState): Promise<Delta> {
  return withSpan('critic', 'node', {}, async (span: Span) => {
    const reviews = await Promise.all(
      state.workspace
        .filter((t) => t.status === 'done')
        .map(async (task) => {
          const want = skillOf(kindOf(task)).requirement
          const head = `验收要求：${want}\n子任务目标：${baseGoal(task.goal)}`
          const verdict = await callModel('review', `${head}\n产出：${task.result ?? ''}`)
          const ok = verdict.trim().startsWith('PASS')
          return { task, ok, reason: verdict.replace(/^REDO\s*/, '').trim() }
        })
    )
    const rejected = reviews.filter((r) => !r.ok)
    span.attrs.rejected = rejected.length
    if (rejected.length === 0) return {}
    if (state.reviewRounds >= MAX_REVIEW_ROUNDS) {
      span.attrs.outcome = 'give-up'
      return {
        degraded: true,
        workspace: rejected.map((r) => ({ ...r.task, status: 'failed' as const })),
      }
    }
    span.attrs.outcome = 'redo'
    const redo = rejected.map((r) => ({
      ...r.task,
      status: 'pending' as const,
      goal: `${baseGoal(r.task.goal)} ｜ 评审意见：${r.reason}`,
    }))
    return { reviewRounds: state.reviewRounds + 1, workspace: redo }
  })
}

/** 汇总：拿到结果的都带上，降级的标出来。 */
export function respondNode(state: GraphState): Delta {
  const lines = state.workspace
    .filter((t) => t.result)
    .map((t) => `${t.status === 'done' ? '·' : '·（未达标）'} ${t.result}`)
  return {
    messages: [{ role: 'assistant', content: lines.join('\n') || '这次没有产出可用的结果。' }],
    degraded: state.workspace.some((t) => t.status !== 'done'),
  }
}
// 三、接线：分叉（路由）、扇出（并行执行）、回边（Critic 打回）三种边今天都在。
const sendPending = (state: GraphState): Send[] =>
  state.workspace
    .filter((t) => t.status === 'pending')
    .map((task) => new Send('executor', { task }))

export function buildGraph() {
  return new StateGraph(AgentAnnotation)
    .addNode('supervisor', supervisorNode)
    .addNode('smalltalk', smalltalkNode)
    .addNode('planner', plannerNode)
    .addNode('executor', executorNode)
    .addNode('critic', criticNode)
    .addNode('respond', respondNode)
    .addEdge(START, 'supervisor')
    .addConditionalEdges(
      'supervisor',
      (s: GraphState) => (s.route === 'smalltalk' ? 'smalltalk' : 'planner'),
      ['planner', 'smalltalk']
    )
    .addEdge('smalltalk', END)
    .addConditionalEdges('planner', (s: GraphState) => sendPending(s), ['executor', END])
    .addEdge('executor', 'critic')
    .addConditionalEdges(
      'critic',
      (s: GraphState) => {
        const next = sendPending(s)
        return next.length === 0 ? 'respond' : next
      },
      ['executor', 'respond']
    )
    .addEdge('respond', END)
    .compile()
}
// 四、跑一次请求，并把整棵调用树录下来。
export interface RunOutcome {
  output: string
  route: string
  routingReason: string
  degraded: boolean
  durationMs: number
  spans: Span[]
}

export async function runRequest(caseId: string, request: string): Promise<RunOutcome> {
  const tracer = new Tracer()
  setActiveTracer(tracer)
  const graph = buildGraph()
  try {
    const state = await tracer.span('request', 'request', { case: caseId }, async () =>
      graph.invoke(
        { messages: [{ role: 'user', content: request } as Message] },
        { maxConcurrency: EXECUTOR_CONCURRENCY }
      )
    )
    const root = tracer.spans[0]
    const last = state.messages.at(-1)
    return {
      output: last && typeof last.content === 'string' ? last.content : '',
      route: state.route ?? 'smalltalk',
      routingReason: state.routingReason ?? '',
      degraded: state.degraded,
      durationMs: root.endMs - root.startMs,
      spans: tracer.spans,
    }
  } finally {
    setActiveTracer(undefined)
  }
}
