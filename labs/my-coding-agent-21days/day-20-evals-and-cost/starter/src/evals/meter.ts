/**
 * 用量计量。本天新增，但它**没有自己算账**——账还是第六天那个 LimitTracker 记的。
 *
 * 这一点值得说清楚：循环里已经有一本账了（三条硬上限就是靠它记的），
 * 成本统计再数一遍的话，迟早会出现「/limits 说用了三万，评估报告说用了两万八」
 * 这种谁也说不清的情况。所以这里只做两件事：
 *   - 把 usage 事件喂给同一个 LimitTracker，token 口径完全一致
 *   - 额外记下 cachedTokens 与轮数，那是上限记账不关心、而成本统计需要的
 *
 * 形状和第七天的 recordTurn、第十二天的 sampleUsage 一样：一个透明包装，
 * 事件原样传下去，路过时记一笔。循环与渲染层都不知道有人在旁边计量。
 */
import type { AgentEvent } from '../kernel/types.js'
import { LimitTracker } from '../kernel/limits.js'

export class UsageMeter {
  /** 账本复用第六天那一个，口径与 /limits 完全一致 */
  private readonly tracker = new LimitTracker()
  /**
   * 轮数 = 收到几条 usage 事件。一轮一条，所以它同时是轮数计数器。
   * **代价要说明白**：网关不回传 usage 时这一列和 token 列一起失效，
   * 报告里会标成「不可用」而不是悄悄显示 0。
   */
  rounds = 0
  promptTokens = 0
  completionTokens = 0
  /** 输入里命中缓存的那部分。它是 promptTokens 的**子集**，不另外累加 */
  cachedTokens = 0

  /**
   * TODO(3)：现在这里把三个数各自攒了一份，却**没有喂给 LimitTracker**，
   * 于是 totalTokens 永远是 0，而且成本统计变成了第二本账——
   * 迟早会出现「/limits 说用了三万、评估报告说用了两万八」这种谁也说不清的情况。
   *
   * 请补上那一行 addUsage，让 token 口径与循环里那三条硬上限完全一致。
   */
  record(event: Extract<AgentEvent, { type: 'usage' }>): void {
    this.rounds += 1
    this.promptTokens += event.promptTokens
    this.completionTokens += event.completionTokens
    this.cachedTokens += event.cachedTokens
  }

  /** 输入加输出，跨轮累计。这个数直接取自 LimitTracker，不在这里重算 */
  get totalTokens(): number {
    return this.tracker.stats.tokens
  }
}

/**
 * 透明包装：事件原样传下去，路过时把 usage 记一笔。
 *
 * meter 允许是 undefined，这样接线处不用写分支——**没人计量时它就是一段直通管道**。
 * 把「要不要计量」的判断放在这里而不是放在 turn.ts，是为了让接线处只多一层括号：
 * 这一天的改动要能被后面几天原样带走，越短越好。
 */
export async function* meterTurn(
  meter: UsageMeter | undefined,
  events: AsyncIterable<AgentEvent>
): AsyncGenerator<AgentEvent> {
  for await (const event of events) {
    if (meter && event.type === 'usage') meter.record(event)
    yield event
  }
}
