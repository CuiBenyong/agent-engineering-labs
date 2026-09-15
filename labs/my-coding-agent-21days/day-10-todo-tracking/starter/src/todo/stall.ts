/**
 * 停滞与打转的识别。本天新增。
 *
 * 先说清它和第六天那个打转检测的分工，因为很容易做成同一个东西：
 *
 *   打转检测（D6，kernel/repeat.ts）  看「有没有一字不差地重复调用」
 *   停滞检测（本文件）                看「有没有进展」
 *
 * 前者漏掉的正是后者要抓的东西：**每一轮都在做不一样的事，但一件都没做完。**
 * 读了 A 又读了 B 又读了 C，参数每次都不同，打转检测一次都不会响；
 * 而清单从头到尾一个字没变——这才是长任务里最常见的失控形态，
 * 因为它看起来一直很忙。
 *
 * 所以停滞的度量必须与具体工具无关。本课用两个信号，都取自现成的东西：
 *
 *   1. **清单多少轮没变**（TodoList.revision，第六天的 LimitTracker 提供轮数）
 *   2. **同一条被重开了几次**（done 又变回 pending / in_progress）
 *
 * 第二条比第一条更严重：它的意思是「它以为做完了，又发现没做完」，
 * 连续两次基本可以断定它在原地兜圈子。
 *
 * 干预分两级，**先给机会再抬头**，和第六天的打转打断同一条思路：
 *   第一次命中  回灌一条提醒，让它自己更新清单或者说明卡在哪
 *   第二次命中  停下这一轮，走和硬上限一样的出口
 *
 * 为什么提醒用 user 角色回灌：assistant 消息会被它当成自己说过的话，于是它很可能
 * 顺着原来那条思路继续写下去；user 消息才是「有人在催」。这一条值得记住——
 * **给模型的纠正，角色选错了效果会反过来。**
 */

/**
 * 提醒消息统一带这个前缀，两个用处：
 *   1. 用户在终端上一眼看出这句话不是模型说的，是程序在催
 *   2. 它以 user 角色进消息数组，而离线剧本是按「最后一条用户消息」选分支的——
 *      有了前缀，剧本才能认出「这不是新指令，是催我」而不至于跳到别的场景
 */
export const NUDGE_PREFIX = '（系统提醒）'

export interface StallLimits {
  /** 清单连续多少轮没有变化就算停滞 */
  quietRounds: number
  /** 同一条任务被重开几次就算在兜圈子 */
  maxReopen: number
}

export const DEFAULT_STALL: StallLimits = {
  quietRounds: 3,
  maxReopen: 2,
}

export interface StallSignal {
  /** nudge 是回灌一条提醒并继续；stop 是停下这一轮 */
  action: 'nudge' | 'stop'
  reason: 'quiet' | 'reopen'
  message: string
}

/** 每一轮开始前喂它一次。它只需要两个数字：转了几轮、清单的版本号 */
export class StallDetector {
  readonly limits: StallLimits
  private lastRevision = -1
  private lastChangeRound = 0
  private hits = 0

  constructor(overrides: Partial<StallLimits> = {}) {
    this.limits = { ...DEFAULT_STALL, ...overrides }
  }

  check(rounds: number, revision: number, maxReopen: number): StallSignal | null {
    // TODO(5) 停滞检测整个还没写，现在永远返回 null。要按顺序做四件事：
    //   ① 记账：revision 与上次不同就说明有进展，把 lastRevision 与 lastChangeRound 更新掉
    //   ② 重开信号：maxReopen 达到阈值就命中（这条比「清单不动」更严重，
    //      它的意思是「它以为做完了，又发现没做完」），所以放在前面先判
    //   ③ 停滞信号：rounds 减 lastChangeRound 达到 quietRounds 就命中
    //   ④ **豁免**：revision 为 0 表示清单一次都没被写过——三步以内的活儿不该被催。
    //      少了这一条，任何一次不用清单的短对话转到第三轮都会被提醒，
    //      这个假警报比不做检测更糟，因为用户很快就学会无视它了。
    //   命中之后一律走下面的 signal()，由它决定这次是提醒还是停下。
    void rounds
    void revision
    void maxReopen
    void this.lastRevision
    void this.lastChangeRound
    return null
  }

  /** 第一次给机会，第二次就停。抬头是最后一步 */
  private signal(reason: StallSignal['reason'], message: string): StallSignal {
    if (this.hits >= 2) {
      return {
        action: 'stop',
        reason,
        message: `${message}（这是第 ${this.hits} 次提醒，按停滞规则停下这一轮。）`,
      }
    }
    return { action: 'nudge', reason, message }
  }
}
