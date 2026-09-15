/**
 * 成本。本天新增，也是全课唯一出现「钱」的地方——前十九天只打印 token 数。
 *
 * **这里没有任何一家网关的报价，一个数字都没有。** 单价全部从环境变量读，
 * 默认值是 0，没配就显示「未配单价」而不是显示 0.00。这不是偷懒，是三条理由：
 *
 *   1. 价目随时会变，写进代码就等于给这份代码加了一个会过期的事实。
 *   2. 同一个模型在不同网关上的价钱不一样，而本课从第一天起就不绑任何一家。
 *   3. 默认 0 会让「未配单价」看起来像「不要钱」。所以必须显式区分这两件事：
 *      **没配单价时成本那一列是不可用，不是零。**
 *
 * 缓存怎么计费也不写死：这里的算法（命中的那部分按 cachedPerMTok 算、
 * 其余输入按 inPerMTok 算）只是一种常见做法，**各家的规则不同，
 * 以你所用网关的计费页为准**。要换算法只要改 costOf 这一个函数。
 */

export interface Rates {
  /** 币种只是一个标签，代码不做任何换算 */
  currency: string
  /** 每百万输入 token 的单价 */
  inPerMTok: number
  /** 每百万输出 token 的单价 */
  outPerMTok: number
  /** 每百万「命中缓存的输入 token」的单价 */
  cachedPerMTok: number
}

export const RATE_ENV_KEYS = [
  'LLM_PRICE_CURRENCY',
  'LLM_PRICE_IN',
  'LLM_PRICE_OUT',
  'LLM_PRICE_CACHED',
] as const

function num(raw: string | undefined): number {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export function loadRates(env: NodeJS.ProcessEnv = process.env): Rates {
  return {
    currency: env.LLM_PRICE_CURRENCY ?? '单位',
    inPerMTok: num(env.LLM_PRICE_IN),
    outPerMTok: num(env.LLM_PRICE_OUT),
    cachedPerMTok: num(env.LLM_PRICE_CACHED),
  }
}

/** 三个单价全是 0 就是「没配」。没配时成本不可用，而不是等于零 */
export function isPriced(rates: Rates): boolean {
  return rates.inPerMTok > 0 || rates.outPerMTok > 0 || rates.cachedPerMTok > 0
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

export function costOf(usage: Usage, rates: Rates): number {
  // cachedTokens 是 promptTokens 的子集，所以先把它从输入里扣掉再分别计价
  const fresh = Math.max(0, usage.promptTokens - usage.cachedTokens)
  return (
    (fresh * rates.inPerMTok +
      usage.cachedTokens * rates.cachedPerMTok +
      usage.completionTokens * rates.outPerMTok) /
    1_000_000
  )
}

export function formatCost(usage: Usage, rates: Rates): string {
  if (!isPriced(rates)) return '未配单价（成本不可用，不是 0）'
  return `${costOf(usage, rates).toFixed(6)} ${rates.currency}`
}
