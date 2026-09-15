// 可观测的两件事：一次请求长什么样（trace），以及一批请求加起来花了多少、错了多少（面板）。
// 关键在于两者用的是**同一份原始数据**——面板不是另一套埋点，是 trace 的聚合。

import { AsyncLocalStorage } from 'node:async_hooks'

export type SpanKind = 'request' | 'node' | 'model'

export interface Span {
  id: string
  parentId?: string
  name: string
  kind: SpanKind
  startMs: number
  endMs: number
  attrs: Record<string, string | number | boolean>
  promptTokens: number
  completionTokens: number
}

// 价目表沿用 W2：输入 $0.15 / 1M、输出 $0.60 / 1M；字符按 D6 的口径 1:1 当 token 保守高估。
export const PRICE_IN = 0.15
export const PRICE_OUT = 0.6
export const costOf = (inTok: number, outTok: number): number =>
  (inTok * PRICE_IN + outTok * PRICE_OUT) / 1_000_000

// 一、Tracer。父子关系靠 AsyncLocalStorage 传递——这正是 OpenTelemetry 说的 context
// propagation：节点函数不用多一个 parentSpanId 参数，异步上下文替你把它带过去。
const parentCtx = new AsyncLocalStorage<string>()

export class Tracer {
  readonly spans: Span[] = []
  private seq = 0
  private rootId?: string

  private open(name: string, kind: SpanKind, attrs: Span['attrs']): Span {
    const span: Span = {
      id: `s${(this.seq += 1)}`,
      // 练习 4：父指针没接上，于是所有 span 都平铺在根下——你只知道发生过什么，
      // 不知道谁在谁里面，更看不出哪两个执行者是并行的。
      // 提示：用 parentCtx.getStore() 取当前的父 span id，取不到就落到 this.rootId。
      parentId: undefined,
      name,
      kind,
      startMs: performance.now(),
      endMs: 0,
      attrs,
      promptTokens: 0,
      completionTokens: 0,
    }
    if (kind === 'request') this.rootId = span.id
    this.spans.push(span)
    return span
  }

  /** 包一段执行。开始与结束都记下来，所以「谁跟谁在并行」是能从数据里读出来的。 */
  async span<T>(
    name: string,
    kind: SpanKind,
    attrs: Span['attrs'],
    fn: (span: Span) => Promise<T> | T
  ): Promise<T> {
    const span = this.open(name, kind, attrs)
    try {
      return await parentCtx.run(span.id, async () => fn(span))
    } finally {
      span.endMs = performance.now()
    }
  }

  /** 模型调用发生在 infra 层，不方便包在 span() 里，所以给它一个直接落 span 的入口。 */
  addModelSpan(name: string, attrs: Span['attrs'], usage: Partial<Span>): void {
    Object.assign(this.open(name, 'model', attrs), usage)
  }
}

let active: Tracer | undefined

export function setActiveTracer(tracer?: Tracer): void {
  active = tracer
}

/** 让节点函数不用拿着 tracer 到处传：有活跃 trace 就开一个 span，没有就照常执行。 */
export async function withSpan<T>(
  name: string,
  kind: SpanKind,
  attrs: Span['attrs'],
  fn: (span: Span) => Promise<T> | T
): Promise<T> {
  if (!active) return fn({ attrs } as Span)
  return active.span(name, kind, attrs, fn)
}

/** infra/model.ts 每调一次模型就来这里报一次数。没有活跃 trace（比如 judge）就不记。 */
export function recordModelCall(call: {
  intent: string
  model: string
  promptTokens: number
  completionTokens: number
  startMs: number
  endMs: number
}): void {
  const { intent, model, ...usage } = call
  active?.addModelSpan(`model:${intent}`, { intent, model }, usage)
}

// 二、把平铺的 span 列表还原成一棵树。多 Agent 的一次请求不是一条线，是一棵树：
// 有分叉（路由）、有扇出（并行的执行者）、有回边（Critic 打回之后重跑的那一个）。
export function renderTree(spans: Span[]): string[] {
  const children = new Map<string | undefined, Span[]>()
  for (const s of spans) children.set(s.parentId, [...(children.get(s.parentId) ?? []), s])
  for (const list of children.values()) list.sort((a, b) => a.startMs - b.startMs)

  const lines: string[] = []
  const walk = (parentId: string | undefined, prefix: string): void => {
    const list = children.get(parentId) ?? []
    list.forEach((span, i) => {
      const last = i === list.length - 1
      // 与前面某个兄弟在时间上重叠，就是真的在并行——这一列是并发上限有没有生效的直接证据
      const overlap = i > 0 && span.startMs < Math.max(...list.slice(0, i).map((s) => s.endMs))
      const attrs = Object.entries(span.attrs).map(([k, v]) => `${k}=${v}`)
      const took = `${(span.endMs - span.startMs).toFixed(1)}ms${overlap ? ' ‖并行' : ''}`
      lines.push(`${prefix}${last ? '└─ ' : '├─ '}${span.name} ${took}  ${attrs.join(' ')}`)
      walk(span.id, `${prefix}${last ? '   ' : '│  '}`)
    })
  }
  walk(undefined, '')
  return lines
}

// 三、面板。它回答四个问题：错了多少、慢在哪、花了多少、钱花在哪个角色身上。
export interface RequestRecord {
  caseId: string
  routeOk: boolean
  degraded: boolean
  fallback: boolean
  score: number
  pass: boolean
  rubricVersion: string
  judgeModel: string
  promptVersion: string
  durationMs: number
  spans: Span[]
}

export type Panel = ReturnType<typeof aggregate>
export type PanelResult = { ok: true; panel: Panel } | { ok: false; reason: string }

export function buildPanel(records: RequestRecord[]): PanelResult {
  if (records.length === 0) return { ok: false, reason: '没有可聚合的记录' }
  // 分数只在同一套 judge 提示词内部可比：混着算出来的「平均分」是个没有含义的数字。
  const rubrics = new Set(records.map((r) => `${r.rubricVersion}/${r.judgeModel}`))
  if (rubrics.size > 1) {
    const list = [...rubrics].join('、')
    return { ok: false, reason: `混了 ${rubrics.size} 套评分口径（${list}），拒绝合并计算` }
  }
  return { ok: true, panel: aggregate(records) }
}

function aggregate(records: RequestRecord[]) {
  const models = records.flatMap((r) => r.spans).filter((s) => s.kind === 'model')
  const promptTokens = models.reduce((n, s) => n + s.promptTokens, 0)
  const completionTokens = models.reduce((n, s) => n + s.completionTokens, 0)
  const costIn = (promptTokens * PRICE_IN) / 1_000_000
  const costOut = (completionTokens * PRICE_OUT) / 1_000_000
  const took = records.map((r) => r.durationMs).sort((a, b) => a - b)
  const at = (p: number): number => took[Math.min(took.length - 1, Math.floor(took.length * p))]
  const rate = (f: (r: RequestRecord) => boolean): number =>
    records.filter(f).length / records.length

  const perIntent = new Map<string, [number, number]>()
  for (const s of models) {
    const key = String(s.attrs.intent)
    const [calls, cost] = perIntent.get(key) ?? [0, 0]
    perIntent.set(key, [calls + 1, cost + costOf(s.promptTokens, s.completionTokens)])
  }

  return {
    requests: records.length,
    modelCalls: models.length,
    callsPerRequest: models.length / records.length,
    passRate: rate((r) => r.pass),
    routeAccuracy: rate((r) => r.routeOk),
    degradedRate: rate((r) => r.degraded),
    fallbackRate: rate((r) => r.fallback),
    p50: at(0.5),
    p95: at(0.95),
    promptTokens,
    completionTokens,
    costIn,
    costOut,
    costTotal: costIn + costOut,
    // 多 Agent 的关键一行：一次用户请求会产生好几次模型调用，
    // 所以「每次调用多少钱」不反映真实单价，「每次请求多少钱」才反映。
    // 练习 5：多 Agent 的一次用户请求会产生好几次模型调用，所以「每次调用多少钱」
    // 不是真实单价。现在这一行按调用摊，面板上的「/ 请求」会比真实值小一个数量级。
    // 提示：分母换成请求数，并把「按调用摊」那一行留着做对照——两个数字放一起才有说服力。
    costPerRequest: (costIn + costOut) / Math.max(1, models.length),
    costPerCall: models.length === 0 ? 0 : (costIn + costOut) / models.length,
    byIntent: [...perIntent.entries()]
      .map(([name, [calls, cost]]): [string, number, number] => [name, calls, cost])
      .sort((a, b) => b[2] - a[2]),
  }
}

export const usd = (n: number): string => `$${n.toFixed(6)}`
export const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
