/**
 * 模拟用户 —— 把单轮任务扩展成多轮。
 *
 * 为什么需要它：真实的客服场景里，用户第一句话往往不完整。他会先问一句，
 * 看到回复不满意再追问，追问才是 Agent 真正容易翻车的地方——
 * 上下文变长、约束被追问冲淡、工具被反复调用。**单轮评估结构上看不到这一段。**
 *
 * ⚠️ 模拟用户自己会引入偏差，这是今天必须讲清楚的一点：
 *
 * 1. **规则型模拟用户（本文件）过于一致**。它每次都用同一句话追问，
 *    于是评估出的失败模式也只有一种。真实用户会用一百种说法表达同一个意思，
 *    其中某些说法会触发完全不同的路径。**分数会偏乐观。**
 * 2. **模型型模拟用户会泄题**。让另一个模型扮演用户时，它拿到的是任务的完整设定，
 *    很容易在追问里把答案说出来（「你去查一下政策表第 3 条」），
 *    于是被评的 Agent 是在开卷考试。**分数同样偏乐观，而且更难察觉。**
 * 3. **模拟用户太有耐心**。它不会挂电话、不会骂人、不会中途改主意。
 *    真实对话里的放弃行为是一个重要信号，模拟用户把它抹掉了。
 *
 * 所以多轮评估的正确读法是：**它是发现失败的工具，不是估计成功率的工具。**
 * 模拟用户跑出来的成功率不能直接对外报，它抓出来的那条死循环可以直接去修。
 *
 * 上游参考：tau2-bench（sierra-research/tau2-bench）就是把模拟用户当成基准的一等公民，
 * 它的用户侧行为也是脚本 + 模型混合的。
 */

import type { EvalTarget, Message, Task, ToolCall, Transcript, WorldState } from '../core/types'

/**
 * 用户策略：看 Agent 上一句回复，决定下一句说什么。
 * 返回 null 表示这一轮就结束（满意，或者放弃）。
 */
export interface UserPolicy {
  name: string
  /** maxTurns 含第一轮。设 1 就退化成单轮评估 */
  maxTurns: number
  next(assistantReply: string, turnIndex: number, task: Task): string | null
}

/** 按 taskId 查用户策略。 */
export type UserTable = Record<string, UserPolicy>

/**
 * 一个「不接受拒绝」的用户：只要 Agent 说办不了，就让它再查一次。
 *
 * 这是现实里最常见的一类追问，也是靶子缺陷 3 的触发条件——
 * 它在单轮评估里**永远不会出现**，因为单轮的第一句话里没人会说「再查一次」。
 */
export const persistentUser: UserPolicy = {
  name: 'persistent',
  maxTurns: 3,
  next(reply: string, turnIndex: number, task: Task): string | null {
    if (turnIndex >= 2) return null
    const rejected = reply.includes('无法退款') || reply.includes('没有找到')
    if (!rejected) return null
    const id = task.prompt.match(/[A-Z]\d{4}/)?.[0] ?? ''
    return `不对吧，麻烦你再查一次订单 ${id}，我记得还在期限内。`
  },
}

/** 一个一问就走的用户：用来做对照组，证明多轮那条路径确实是多轮才走得到。 */
export const oneShotUser: UserPolicy = {
  name: 'one-shot',
  maxTurns: 1,
  next(): string | null {
    return null
  },
}

/** 多轮运行的结果：一条合并后的轨迹，外加轮数。 */
export interface MultiTurnResult {
  transcript: Transcript
  turns: number
}

/** 把两条轨迹接起来。token、花费、耗时全部累加——多轮的成本必须是全程成本。 */
function mergeTranscripts(parts: readonly Transcript[]): Transcript {
  const messages: Message[] = []
  const toolCalls: ToolCall[] = []
  let inputTokens = 0
  let outputTokens = 0
  let costCents = 0
  let durationMs = 0
  for (const p of parts) {
    messages.push(...p.messages)
    toolCalls.push(...p.toolCalls)
    inputTokens += p.inputTokens
    outputTokens += p.outputTokens
    costCents += p.costCents
    durationMs += p.durationMs
  }
  return {
    messages,
    toolCalls,
    inputTokens,
    outputTokens,
    // 分保留两位小数，避免浮点累加让总账对不上
    costCents: Math.round(costCents * 100) / 100,
    durationMs,
  }
}

/**
 * 跑一次多轮会话。
 *
 * ⚠️ 世界状态**在轮次之间是共享的**（这与试次之间必须隔离不冲突）：
 * 同一次会话里，第一轮退了款，第二轮就该看到订单已退款。
 * 隔离的边界是试次，不是轮次。
 */
export async function runMultiTurn(
  task: Task,
  target: EvalTarget,
  world: WorldState,
  user: UserPolicy
): Promise<MultiTurnResult> {
  // TODO 练习 4：把单轮跑成多轮。
  //
  // 循环最多 user.maxTurns 轮，每一轮：
  //   1. 用当前 prompt 造一个 turnTask（`{ ...task, prompt }`），对**同一个 world** 跑一次
  //   2. 取这一轮最后一条 assistant 消息，交给 user.next 决定下一句
  //   3. next 返回 null 就跳出循环
  // 最后用 mergeTranscripts 把各轮轨迹接成一条。
  //
  // ⚠️ world 在轮次之间是**共享**的（第一轮退了款，第二轮就该看到订单已退款）。
  //    隔离的边界是试次，不是轮次——不要在这里重建世界。
  const parts: Transcript[] = [await target.run(task, world)]
  const turns = 1
  void user
  void mergeTranscripts

  return { transcript: parts[0], turns }
}

/**
 * 把一个单轮靶子包装成多轮靶子。
 *
 * 这么做的好处是 `runner.ts` 一行都不用改：多轮评估在它眼里仍然是
 * 「跑一次，拿一条轨迹」。所有 D1 的指标、D4 的轨迹评分器都照常生效。
 */
export function withSimulatedUser(target: EvalTarget, users: UserTable): EvalTarget {
  return {
    name: `${target.name} + simulated-user`,
    async run(task: Task, world: WorldState): Promise<Transcript> {
      const user = users[task.id] ?? users['*'] ?? oneShotUser
      const { transcript } = await runMultiTurn(task, target, world, user)
      return transcript
    },
  }
}
