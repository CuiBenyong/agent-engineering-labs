import { getEncoding } from 'js-tiktoken'

/**
 * 最小链路追踪 + 成本计量。
 *
 * 这里**不引入任何外部服务**。Langfuse、OpenTelemetry 这类东西解决的是「多台机器上的
 * 上千条链路怎么汇总、怎么检索」，而在你想清楚「一条链路要记哪些字段」之前接进去，
 * 只会得到一堆没有语义的时间戳。所以先用 80 行把语义写对，再谈接哪家。
 *
 * 一条链路记五段：解析 → 向量化 → 检索 → 重排 → 生成。每段记三样东西：
 * 耗时、进出的 token 数、按单价折算的钱。**耗时和钱必须分开看**——
 * 最慢的那一段和最贵的那一段经常不是同一段，这正是加这套东西的意义。
 */

export type Stage = 'parse' | 'embed' | 'retrieve' | 'rerank' | 'generate'

export const STAGE_LABEL: Record<Stage, string> = {
  parse: '解析',
  embed: '向量化',
  retrieve: '检索',
  rerank: '重排',
  generate: '生成',
}

/**
 * 单价，美元 / 每百万 token。
 *
 * ⚠️ 这是一张**占位价目表，不是行情**。各家定价会变，也分地区和档位，
 * 用之前请打开你实际要用的那家的官方定价页核对，然后改这里或用环境变量覆盖：
 *
 *   PRICE_EMBED_IN=0.02 PRICE_GEN_IN=3 PRICE_GEN_OUT=15 pnpm start
 *
 * 本实验从这张表算出来的**绝对金额没有意义**，有意义的是两件事：
 * 一是四项之间的**比例**，二是这个比例在你改了配置（topK、要不要重排、换模型）之后**怎么变**。
 * token 数是真跑出来的，比例随单价而变，所以看结论时永远要连着单价一起看。
 */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export interface Price {
  in: number
  out: number
}

export function loadPrices(): Record<Stage, Price> {
  return {
    parse: { in: 0, out: 0 }, // 本地 CPU，不按 token 计费
    embed: { in: envNum('PRICE_EMBED_IN', 0.02), out: 0 },
    retrieve: { in: 0, out: 0 }, // 数据库时间，算在机器账上不算在 token 账上
    rerank: { in: envNum('PRICE_RERANK_IN', 0.1), out: 0 },
    generate: { in: envNum('PRICE_GEN_IN', 3), out: envNum('PRICE_GEN_OUT', 15) },
  }
}

const PRICES = loadPrices()

/**
 * 按单价折算金额。**练习 5 挖的就是这个函数。**
 * 单位换算只有一处容易错：单价是「每百万 token」，所以要除以 1e6，不是 1e3。
 */
export function estimateCost(stage: Stage, tokensIn: number, tokensOut: number): number {
  const price = PRICES[stage]
  return (tokensIn * price.in + tokensOut * price.out) / 1_000_000
}

/**
 * token 计数。这里统一用 OpenAI 的 cl100k_base 分词器做**近似**：
 * embedding 那一侧它是准的，生成那一侧各家分词器不同，数出来会有出入。
 * 要精确的生成侧 token 数，得调各家自己的计数接口——
 * 但做成本归因时你要的是「哪一项占大头」，近似值足够回答这个问题。
 */
const encoder = getEncoding('cl100k_base')

export function countTokens(text: string): number {
  return encoder.encode(text).length
}

export interface Span {
  name: Stage
  ms: number
  tokensIn: number
  tokensOut: number
  usd: number
}

export class Trace {
  readonly spans: Span[] = []

  /**
   * 开一段。返回的函数是「结束这一段」，调用时把这一段真正消耗的 token 数交进来。
   *
   * 为什么不做成 `trace.step(name, fn)` 那种包一层的写法：token 数只有在业务代码
   * 拿到结果之后才知道（生成侧要读响应里的 usage），包起来就得再回传一次，反而绕。
   */
  begin(name: Stage): (tokensIn?: number, tokensOut?: number) => void {
    const t0 = performance.now()
    return (tokensIn = 0, tokensOut = 0) => {
      const ms = Number((performance.now() - t0).toFixed(2))
      this.spans.push({
        name,
        ms,
        tokensIn,
        tokensOut,
        usd: estimateCost(name, tokensIn, tokensOut),
      })
    }
  }

  get totalMs(): number {
    return Number(this.spans.reduce((s, x) => s + x.ms, 0).toFixed(2))
  }

  get totalUsd(): number {
    return this.spans.reduce((s, x) => s + x.usd, 0)
  }

  /** 一次问答的追踪记录，按「耗时占比 / 花费占比」两栏并排——因为它们经常指向不同的那一段 */
  lines(): string[] {
    const ms = this.totalMs || 1
    const usd = this.totalUsd || 1
    const rows = this.spans.map((s) => {
      const label = STAGE_LABEL[s.name].padEnd(4, '　')
      const time = `${s.ms.toFixed(2).padStart(8)} ms (${((s.ms / ms) * 100).toFixed(1).padStart(5)}%)`
      const token = `${String(s.tokensIn).padStart(6)} in /${String(s.tokensOut).padStart(5)} out`
      const money = `$${s.usd.toFixed(8)} (${((s.usd / usd) * 100).toFixed(1).padStart(5)}%)`
      return `   ${label} ${time}  ${token}  ${money}`
    })
    rows.push(
      `   合计　 ${this.totalMs.toFixed(2).padStart(8)} ms              $${this.totalUsd.toFixed(8)}`
    )
    return rows
  }

  /** 最慢的一段与最贵的一段。定位优化对象时，先看这两个名字是不是同一个 */
  hotspots(): { slowest: Stage; costliest: Stage } {
    const slowest = [...this.spans].sort((a, b) => b.ms - a.ms)[0]
    const costliest = [...this.spans].sort((a, b) => b.usd - a.usd)[0]
    return { slowest: slowest.name, costliest: costliest.name }
  }
}
