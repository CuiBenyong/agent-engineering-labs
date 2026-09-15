/**
 * token 估算与校准。本天新增，是今天所有数字的来源。
 *
 * 三件事在这里一次说清：
 *
 * 一、**为什么不引 tokenizer 包。** 精确计数只能靠模型自己那套分词表，而这门课要连的是
 *    任意一个 OpenAI 兼容网关——网关后面可能是任何一家的任何一个模型，分词表根本不唯一。
 *    引一个包只会给你一种精确的错觉：算得很准，但算的是别人的分词。
 *
 * 二、**估算器的形状：两个系数。** 中日韩字符一个字大致是一个 token，
 *    英文与符号大致是几个字符一个 token。所以估算式只有两项：
 *      tokens ≈ a × 中日韩字符数 + b × 其余字符数
 *    第八天那个 a=1、b=1/4 的版本就是这个式子的默认取值。
 *
 * 三、**系数不是猜出来的，是回归出来的。** 每次请求末尾网关都会回传 usage，
 *    里面的 prompt_tokens 就是「这段文本真实是多少 token」。把若干条
 *    （文本, 真实 token 数）当样本做一次最小二乘，就能解出这一对系数。
 *    这是本课唯一需要的一点数学，二元一次方程组，手写十行。
 *
 * 校准出来的系数是**进程级的一份表**，所有报账共用它。否则同一段文本会在
 * 引用注入那行报一个数、在压缩判定那里报另一个数，用户没法对账。
 */
import type { AgentEvent, Message } from '../kernel/types.js'
import { contentToText } from '../kernel/types.js'

export interface Coefficients {
  /** 每个中日韩字符算多少 token */
  cjk: number
  /** 每个其余字符算多少 token */
  rest: number
}

/** 默认系数：与第八天那个粗估算完全等价（cjk 一个字一个 token，其余四个字符一个） */
export const DEFAULT_COEFF: Coefficients = { cjk: 1, rest: 0.25 }

/** 字符分类的口径与第八天一致：中日韩统一表意文字加全角标点 */
const CJK = /[\u3000-\u9fff\uff00-\uffef]/g

export function countMix(text: string): { cjk: number; rest: number } {
  const cjk = (text.match(CJK) ?? []).length
  return { cjk, rest: text.length - cjk }
}

/** 进程级的当前系数。校准成功就换掉它，于是全部报账立刻跟着变准 */
let active: Coefficients = { ...DEFAULT_COEFF }

export function activeCoefficients(): Coefficients {
  return { ...active }
}

export function useCoefficients(coeff: Coefficients): void {
  active = { ...coeff }
}

export function estimateTokens(text: string, coeff: Coefficients = active): number {
  const { cjk, rest } = countMix(text)
  return Math.max(1, Math.round(cjk * coeff.cjk + rest * coeff.rest))
}

/** 一条消息的估算值。工具调用的参数也是要发出去的字节，一起算 */
export function estimateMessage(message: Message, coeff: Coefficients = active): number {
  const parts = [contentToText(message.content), ...(message.toolCalls ?? []).map((c) => c.args)]
  return estimateTokens(parts.join(''), coeff)
}

/** 整个消息数组的估算值。这就是「下一次请求要发多少 token」的估算 */
export function estimateMessages(messages: Message[], coeff: Coefficients = active): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message, coeff), 0)
}

/** 把消息数组拼成一段纯文本，用来和 usage 里的 prompt_tokens 配对 */
export function promptTextOf(messages: Message[]): string {
  return messages
    .map((m) => contentToText(m.content) + (m.toolCalls ?? []).map((c) => c.args).join(''))
    .join('')
}

export interface Sample {
  cjk: number
  rest: number
  tokens: number
}

export interface FitResult {
  coeff: Coefficients
  samples: number
  /** 校准前后的平均绝对百分误差 */
  errorBefore: number
  errorAfter: number
  /** 样本的中英比例太单一，解不出两个系数 */
  degenerate: boolean
  note: string
}

/**
 * 校准器。攒样本，然后解一次最小二乘。
 *
 * 样本从哪来：每一轮真实请求末尾的 usage 事件。**不额外发请求去测**——
 * 那要花钱，而且测出来的还是另一段文本。顺路收集是零成本的。
 */
export class Calibrator {
  private readonly samples: Sample[] = []

  add(text: string, tokens: number): void {
    if (tokens <= 0 || text.length === 0) return
    this.samples.push({ ...countMix(text), tokens })
  }

  get size(): number {
    return this.samples.length
  }

  /**
   * 解 tokens ≈ a·cjk + b·rest 的最小二乘（无常数项）。
   *
   * 两个未知数、两条正规方程，直接克拉默法则：
   *   a·Σcjk²   + b·Σcjk·rest = Σcjk·tokens
   *   a·Σcjk·rest + b·Σrest²  = Σrest·tokens
   *
   * 行列式接近 0 意味着样本里中英比例几乎不变（例如全是纯英文），
   * 这时候两个系数无法分开——**必须承认解不出来而不是硬解**，
   * 硬解会得到一对荒唐的系数（常见的是一正一负），比不校准更糟。
   */
  fit(minSamples = 3): FitResult {
    const before = meanAbsPercentError(this.samples, active)
    if (this.samples.length < minSamples) {
      return {
        coeff: activeCoefficients(),
        samples: this.samples.length,
        errorBefore: before,
        errorAfter: before,
        degenerate: false,
        note: `样本只有 ${this.samples.length} 条，至少要 ${minSamples} 条才校准`,
      }
    }

    let sxx = 0
    let sxy = 0
    let syy = 0
    let sxt = 0
    let syt = 0
    for (const s of this.samples) {
      sxx += s.cjk * s.cjk
      sxy += s.cjk * s.rest
      syy += s.rest * s.rest
      sxt += s.cjk * s.tokens
      syt += s.rest * s.tokens
    }

    const det = sxx * syy - sxy * sxy
    // 相对判据而不是绝对判据：样本一大，sxx·syy 本身就是个巨大的数
    if (Math.abs(det) < 1e-6 * Math.max(1, sxx * syy)) {
      const total = this.samples.reduce((sum, s) => sum + s.tokens, 0)
      const chars = this.samples.reduce((sum, s) => sum + s.cjk + s.rest, 0)
      const flat = clamp(total / Math.max(1, chars))
      const coeff = { cjk: flat, rest: flat }
      return {
        coeff,
        samples: this.samples.length,
        errorBefore: before,
        errorAfter: meanAbsPercentError(this.samples, coeff),
        degenerate: true,
        note: '样本的中英比例太单一，两个系数分不开，退回一个统一的每字符系数',
      }
    }

    const coeff = {
      cjk: clamp((sxt * syy - syt * sxy) / det),
      rest: clamp((syt * sxx - sxt * sxy) / det),
    }
    return {
      coeff,
      samples: this.samples.length,
      errorBefore: before,
      errorAfter: meanAbsPercentError(this.samples, coeff),
      degenerate: false,
      note: '已按真实用量回归出中英两个系数',
    }
  }
}

/** 系数只允许落在这个区间：任何分词方案都不会超出它，超出说明样本或回归出了问题 */
function clamp(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(4, Math.max(0.05, value))
}

export function meanAbsPercentError(samples: Sample[], coeff: Coefficients): number {
  if (samples.length === 0) return 0
  const total = samples.reduce((sum, s) => {
    const guess = s.cjk * coeff.cjk + s.rest * coeff.rest
    return sum + Math.abs(guess - s.tokens) / s.tokens
  }, 0)
  return Math.round((total / samples.length) * 1000) / 10
}

/**
 * 拿攒到的样本校准一次并**立刻应用**。返回要打给用户的那一行（没校准就一行都不打）。
 *
 * 每次都重算而不是只算一次：样本越多、覆盖的中英比例越广，系数越稳。
 * 代价只是十行算术，没有任何请求。
 */
export function applyCalibration(calibrator: Calibrator): string[] {
  const fit = calibrator.fit()
  if (fit.samples < 3) return []
  useCoefficients(fit.coeff)
  return [
    `校准：${fit.samples} 条真实用量样本，系数 中日韩 ${fit.coeff.cjk.toFixed(2)} / 其余 ${fit.coeff.rest.toFixed(2)}，` +
      `估算误差 ${fit.errorBefore}% → ${fit.errorAfter}%${fit.degenerate ? '（' + fit.note + '）' : ''}`,
  ]
}

/**
 * 顺路收样本的透明包装。用法和第七天的 recordTurn 一样：
 * 事件原样往下传，路过 usage 的时候记一条样本。
 *
 * 只取这一轮的**第一条** usage：promptText 是发起这一轮之前的快照，
 * 而第二轮的输入已经多了助手消息与工具结果，配不上同一段文本了。
 */
export async function* sampleUsage(
  calibrator: Calibrator,
  promptText: string,
  events: AsyncIterable<AgentEvent>
): AsyncGenerator<AgentEvent> {
  let taken = false
  for await (const event of events) {
    if (event.type === 'usage' && !taken) {
      taken = true
      calibrator.add(promptText, event.promptTokens)
    }
    yield event
  }
}
