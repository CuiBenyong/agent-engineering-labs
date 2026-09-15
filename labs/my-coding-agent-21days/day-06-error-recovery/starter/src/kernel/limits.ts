/**
 * 循环的三条硬上限。本天新增，把 D5 那个孤零零的 MAX_ROUNDS 扩成一套。
 *
 * 为什么一条不够：这三条各自能挡住一类失控，而且互相挡不住。
 *
 *   轮数上限   挡住「反复回灌但一直改不对」——每轮都在动，就是不收敛
 *   时长上限   挡住「一轮转得很慢」——三轮里有一轮跑了个十分钟的测试套件，轮数还很富余
 *   花费上限   挡住「上下文越滚越大」——消息数组每轮整体重发，第八轮的输入是第一轮的好几倍
 *
 * 花费这一条本课**只按 token 数算，不折算成金额**。理由有两个：单价随网关与模型变，
 * 写进代码就等于把课程绑在某一家的价目表上；而且真正需要限制的是「输入规模」这件事本身，
 * token 数就是它的单位。要看钱的话，在你自己的部署里把单价配成环境变量乘一下即可。
 */

export interface RunLimits {
  /** 一轮对话最多转几圈。沿用 D5 的初值 */
  maxRounds: number
  /** 单次任务的墙上时间上限（毫秒） */
  maxMs: number
  /** 单次任务的 token 上限：输入与输出相加，跨轮累计 */
  maxTokens: number
}

export const DEFAULT_LIMITS: RunLimits = {
  maxRounds: 8,
  maxMs: 120_000,
  maxTokens: 60_000,
}

export interface LimitStop {
  /** 哪一条上限触发了 */
  limit: 'rounds' | 'time' | 'tokens'
  /** 回灌给模型、也打给用户的一句话 */
  message: string
}

/**
 * 上限记账。每轮开始前问它一次「还能不能再转」，每次拿到用量就喂给它。
 *
 * 做成一个对象而不是三个散落的变量，是因为 D10 的任务清单、D12 的压缩、D20 的成本统计
 * 都要读同一份账。散着放的话，那三天会各自再数一遍，而且数出来的还不一样。
 */
export class LimitTracker {
  readonly limits: RunLimits
  private readonly startedAt = Date.now()
  private rounds = 0
  private tokens = 0

  constructor(overrides: Partial<RunLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...overrides }
  }

  /** 记一次用量。cachedTokens 只是输入里命中缓存的那部分，不额外累加 */
  addUsage(promptTokens: number, completionTokens: number): void {
    this.tokens += promptTokens + completionTokens
  }

  /** 开始新一轮之前调用。返回 null 表示可以继续 */
  beginRound(): LimitStop | null {
    // 顺序是故意的：先报最好懂的那一条。三条同时超时，用户看到「轮数用完了」最容易判断下一步
    if (this.rounds >= this.limits.maxRounds) {
      return {
        limit: 'rounds',
        message:
          `已经转了 ${this.rounds} 圈还没结束，按轮数上限停下。` +
          '通常是在反复调同一个工具，或者任务该拆小了。',
      }
    }
    // TODO(3)：补上另外两条上限。
    //   时长：Date.now() 减 this.startedAt 超过 this.limits.maxMs，limit 填 'time'
    //   用量：this.tokens 超过 this.limits.maxTokens，limit 填 'tokens'
    // 提示：message 里要带上实际值与上限值，并给出下一步（换一段新对话、把任务拆小），
    // 否则用户看到「停下了」也不知道该干什么。
    // 只有轮数上限挡不住什么：三轮里有一轮跑了个十分钟的测试套件，轮数还很富余。
    this.rounds += 1
    return null
  }

  get stats(): { rounds: number; tokens: number; elapsedMs: number } {
    return { rounds: this.rounds, tokens: this.tokens, elapsedMs: Date.now() - this.startedAt }
  }
}
