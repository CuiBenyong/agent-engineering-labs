/**
 * 最小链路记录器 —— 几十行手写，没有任何第三方依赖。
 *
 * ⚠️ 术语：本文件里的「链路 / 跨度」是 OpenTelemetry 的 trace / span，
 * 与 evalkit 的「轨迹」（Transcript，一次试次的过程记录）是**两个概念**。
 * 轨迹是给评分器看的，链路是给面板看的。本课全程不混用这两个词。
 *
 * 生产环境当然用官方 SDK：它帮你做上下文传播、批量导出、重试、采样、
 * 以及把这些数据发给 collector。这里手写的目的只有一个 ——
 * **让你看清一条 span 到底是什么：一个带 id、父 id、起止时间和一袋属性的结构体。**
 * 看清这一点之后，官方 SDK 的配置项才读得懂。
 */

import { isKnownOperation, type GenAiOperation } from './semconv'

export type AttributeValue = string | number | boolean

/** 一条 span。字段名对齐 OTLP，方便以后直接换成真导出器。 */
export interface Span {
  traceId: string
  spanId: string
  /** 根 span 的父 id 是 undefined。这是判断树根唯一可信的依据。 */
  parentSpanId?: string
  name: string
  operation: GenAiOperation
  startUnixNano: number
  endUnixNano: number
  attributes: Record<string, AttributeValue>
  /** 对齐 OTLP 的 status：ok 或 error。 */
  status: 'ok' | 'error'
  statusMessage?: string
}

/** 十六进制 id。真 SDK 用随机数，这里用计数器 —— 可复现比随机更重要。 */
function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0')
}

export interface TracerOptions {
  /** id 的起始值。固定它，两次运行的链路就逐字相同，方便 diff。 */
  idSeed?: number
  /** 时间源。默认真实时钟；自检里换成一个可控的假时钟。 */
  now?: () => number
}

export class Tracer {
  private nextId: number
  private readonly clock: () => number
  private readonly spans: Span[] = []

  constructor(options: TracerOptions = {}) {
    this.nextId = options.idSeed ?? 1
    this.clock = options.now ?? (() => Date.now())
  }

  private takeId(): number {
    const id = this.nextId
    this.nextId += 1
    return id
  }

  /**
   * 开一条 span。
   *
   * parent 传 undefined 就是一棵新链路的根；传一条已有 span 就继承它的 traceId，
   * 并把自己的 parentSpanId 指过去。**父子关系只在这一处建立**，
   * 所以要验「树是不是真的接上了」，只要验这里的输出。
   */
  start(
    name: string,
    operation: GenAiOperation,
    parent?: Span,
    attributes: Record<string, AttributeValue> = {}
  ): Span {
    if (!isKnownOperation(operation)) {
      // 自造操作名会在后端掉进 other 桶，与没埋一样，所以直接拦在这里
      throw new Error(`非法的 gen_ai.operation.name：${operation}`)
    }
    const span: Span = {
      traceId: parent ? parent.traceId : `t${hex(this.takeId(), 31)}`,
      spanId: `s${hex(this.takeId(), 15)}`,
      parentSpanId: parent?.spanId,
      name,
      operation,
      startUnixNano: this.clock() * 1e6,
      endUnixNano: 0,
      attributes: { ...attributes },
      status: 'ok',
    }
    this.spans.push(span)
    return span
  }

  /** 往一条 span 上补属性。约定允许在 span 结束前的任何时刻补。 */
  setAttributes(span: Span, attributes: Record<string, AttributeValue>): void {
    Object.assign(span.attributes, attributes)
  }

  /**
   * 关一条 span。durationMs 用于把靶子自己记的耗时写进来 ——
   * 离线靶子的耗时是模拟值，用真实钟表会让每次运行的面板都不一样。
   */
  end(span: Span, durationMs?: number): void {
    span.endUnixNano =
      durationMs === undefined ? this.clock() * 1e6 : span.startUnixNano + durationMs * 1e6
  }

  /** 把一条 span 标成失败。**不标 error 的失败在面板上等于没发生过。** */
  fail(span: Span, message: string): void {
    span.status = 'error'
    span.statusMessage = message
  }

  /** 导出全部 span。真 SDK 这里会走 OTLP；我们落盘成 JSONL。 */
  finished(): Span[] {
    return this.spans.slice()
  }

  /** 一行一条 span 的 JSONL，可以直接 grep、可以喂给 jq。 */
  toJsonl(): string {
    return this.spans.map((s) => JSON.stringify(s)).join('\n')
  }
}

/**
 * span 的毫秒耗时。endUnixNano 为 0（还没关）时返回 0。
 *
 * ⚠️ 这里为什么要 round：Unix 纳秒是个十九位数，超过了 JS number 能精确表示的
 * 整数范围（2 的 53 次方，约十六位），存进 number 就已经掉精度了 ——
 * 不 round 的话面板上会出现 278.000128 ms 这种一眼假的小数。
 * 真正的 OTLP 导出器用两个 32 位整数或 BigInt 存时间戳，正是为了躲开这件事。
 */
export function durationMs(span: Span): number {
  if (span.endUnixNano === 0) return 0
  return Math.round((span.endUnixNano - span.startUnixNano) / 1e3) / 1e3
}

/** 按 traceId 分组，并保持首次出现的顺序。 */
export function groupByTrace(spans: Span[]): Map<string, Span[]> {
  const out = new Map<string, Span[]>()
  for (const s of spans) {
    const list = out.get(s.traceId)
    if (list) list.push(s)
    else out.set(s.traceId, [s])
  }
  return out
}

/**
 * 一棵链路的最大层数。根算第 1 层。
 *
 * 这个函数存在的唯一理由是给自检当探针：
 * 如果埋点时把所有 span 的父 id 都写成根，树会塌成两层，
 * 而**每一条 span 的属性依然完全正确**，任何按属性做的断言都照样全绿。
 */
export function treeDepth(spans: Span[]): number {
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  let max = 0
  for (const s of spans) {
    let depth = 1
    let cur = s
    const seen = new Set<string>([s.spanId])
    while (cur.parentSpanId) {
      const parent = byId.get(cur.parentSpanId)
      // 父 id 指向了一个不存在的 span：这是断链，按断链处算
      if (!parent || seen.has(parent.spanId)) break
      seen.add(parent.spanId)
      depth += 1
      cur = parent
    }
    if (depth > max) max = depth
  }
  return max
}
