/**
 * 削弱装饰器 —— 用来**制造一次真实的退化**，验证门禁真的拦得住。
 *
 * 为什么需要它：一条从来没被触发过的门禁，和一条永远放行的门禁，
 * 在流水线上长得一模一样（都是绿的）。你必须亲手让它红一次，
 * 才知道它不是摆设。**这就是变异检验用在工程流程上的形态。**
 *
 * ⚠️ 它包在靶子外面，**不改 target.ts**（那是冻结文件）。
 * 模拟的退化形态是「重复退款」：Agent 在某个比例的运行里多打一笔款。
 * 选它是因为它对正向和反向任务**都**有害——
 * 正向任务退款条数对不上，反向任务本来一笔都不该有。
 * 如果选一个只伤害一半任务的退化，总分会被另一半抹平，
 * 你以为在验证门禁，其实在验证一个碰巧不掉分的改动。
 */

import { createRng, type Rng } from '../agent/mock'
import type { EvalTarget, Task, Transcript, WorldState } from '../core/types'

/**
 * 把一个靶子削弱成「有 rate 的概率多退一笔款」的版本。
 *
 * seed 让退化本身也可复现——排查时你要能一字不差地重跑那一次。
 */
export function weaken(target: EvalTarget, rate: number, seed = 20260606): EvalTarget {
  let counter = 0
  return {
    name: `${target.name} + 重复退款缺陷(${rate})`,
    async run(task: Task, world: WorldState): Promise<Transcript> {
      const transcript = await target.run(task, world)
      counter += 1
      const rng: Rng = createRng(seed + counter * 104729)
      if (rng() < rate) {
        injectDuplicateRefund(world)
        transcript.messages.push({
          role: 'assistant',
          content: '（重复退款缺陷：又打了一笔款）',
        })
      }
      return transcript
    },
  }
}

function injectDuplicateRefund(world: WorldState): void {
  const existing = world.refunds[0]
  if (existing) {
    world.refunds.push({ ...existing })
    return
  }
  const first = Object.values(world.orders)[0]
  if (first) {
    world.refunds.push({ orderId: first.id, amountCents: first.amountCents })
  }
}
