/**
 * 参考解验证 —— D2 新增模块。
 *
 * 核心主张：**在拿一套基准集去考 Agent 之前，先拿它考一个已知正确的参考解。**
 *
 * 参考解是「标准答案」：一个把退款政策写死在代码里、完全确定性的假 Agent。
 * 它跑不过某条任务，只有两种可能——任务本身写错了，或者评分器和任务没配对上。
 * 无论哪一种，那条任务在修好之前都不该被用来评判任何 Agent。
 *
 * 反过来还要防另一头：**一条谁都能通过的任务，同样是坏任务。**
 * 所以这里用一个三人小组去跑每条任务：参考解、永远退款的、什么都不做的。
 * 三个都通过，说明这条任务没有区分度，留着只会把分数抬虚。
 */

import type { EvalTarget, Task, ToolCall, Transcript, WorldState } from './types'
import { REFUND_WINDOW_DAYS } from '../agent/target'
import { runTask } from './runner'
import type { Grader } from './types'

function tool(name: ToolCall['name'], args: Record<string, unknown>, result: unknown): ToolCall {
  return { name, args, result, durationMs: 10 }
}

/** 所有确定性假 Agent 共用的记账，数字固定，保证报告可逐字复现。 */
function transcript(messages: Transcript['messages'], toolCalls: ToolCall[]): Transcript {
  return {
    messages,
    toolCalls,
    inputTokens: 100,
    outputTokens: 40,
    costCents: 0.09,
    durationMs: toolCalls.length * 10,
  }
}

/** 与靶子一致的订单号抽取方式：从用户那句话里取第一个订单号。 */
function orderIdFrom(task: Task, world: WorldState): string {
  const m = task.prompt.match(/[A-Z]\d{4}/)
  return m ? m[0] : (Object.keys(world.orders)[0] ?? '')
}

/**
 * 参考解：把退款政策原样实现一遍，**完全不看 task.polarity**。
 *
 * 不看极性这一点很重要。如果参考解偷看了「这是一条反向任务」，
 * 它验证的就只是「我抄对了答案」，而不是「这条任务在真实规则下有解」。
 */
export function createReferenceTarget(): EvalTarget {
  return {
    name: 'reference (policy oracle)',
    async run(task: Task, world: WorldState): Promise<Transcript> {
      const id = orderIdFrom(task, world)
      const calls: ToolCall[] = []
      const order = world.orders[id]
      calls.push(tool('lookup_order', { orderId: id }, order ?? null))

      if (!order) {
        return transcript([{ role: 'assistant', content: `没有找到订单 ${id}。` }], calls)
      }

      const withinWindow = order.ageDays <= REFUND_WINDOW_DAYS
      calls.push(
        tool('check_policy', { orderId: id, ageDays: order.ageDays }, { refundable: withinWindow })
      )

      if (order.refunded) {
        calls.push(tool('escalate', { orderId: id, reason: 'already refunded' }, { ok: true }))
        world.escalations.push({ orderId: id, reason: 'already refunded' })
        return transcript([{ role: 'assistant', content: `订单 ${id} 已退过款，转人工。` }], calls)
      }

      if (!withinWindow) {
        return transcript([{ role: 'assistant', content: `订单 ${id} 已超出退款期限。` }], calls)
      }

      calls.push(
        tool('issue_refund', { orderId: id, amountCents: order.amountCents }, { ok: true })
      )
      world.refunds.push({ orderId: id, amountCents: order.amountCents })
      world.orders[id] = { ...order, refunded: true }
      return transcript([{ role: 'assistant', content: `已为订单 ${id} 办理退款。` }], calls)
    },
  }
}

/** 退化解一：见单就退。它应该通过全部正向任务、挂掉全部反向任务。 */
export function createAlwaysRefundTarget(): EvalTarget {
  return {
    name: 'always-refund',
    async run(task: Task, world: WorldState): Promise<Transcript> {
      const id = orderIdFrom(task, world)
      const order = world.orders[id]
      const calls = [tool('lookup_order', { orderId: id }, order ?? null)]
      if (order) {
        calls.push(
          tool('issue_refund', { orderId: id, amountCents: order.amountCents }, { ok: true })
        )
        world.refunds.push({ orderId: id, amountCents: order.amountCents })
      }
      return transcript([{ role: 'assistant', content: '已为您退款。' }], calls)
    },
  }
}

/** 退化解二：什么也不做，只说漂亮话。它应该挂掉全部正向任务。 */
export function createNeverActTarget(): EvalTarget {
  return {
    name: 'never-act',
    async run(): Promise<Transcript> {
      return transcript([{ role: 'assistant', content: '已为您处理，请耐心等待。' }], [])
    },
  }
}

/** 一条任务的体检结论。 */
export interface TaskVerdict {
  taskId: string
  /** 参考解通过了吗。false = 任务本身有问题，不是 Agent 无能 */
  referencePassed: boolean
  /** 三个退化解都通过 = 这条任务谁都能过，没有区分度 */
  trivial: boolean
  /** 人话结论 */
  reason: string
}

export interface ReferenceReport {
  verdicts: TaskVerdict[]
  brokenCount: number
  trivialCount: number
}

/**
 * 用参考解与两个退化解逐条体检基准集。
 *
 * 三个假 Agent 都是确定性的，所以每条只跑一次就够——
 * 跑多次只会浪费时间，不会带来新信息。
 */
export async function verifySuite(
  tasks: Task[],
  registry?: Record<string, Grader>
): Promise<ReferenceReport> {
  // TODO(练习 3)：用参考解与两个退化解逐条体检基准集。
  //
  // 对每条任务：
  //   1. 用 createReferenceTarget() 跑一次（三个假 Agent 都是确定性的，k=1 就够，
  //      跑多次只浪费时间不带来新信息）。跑不过 → referencePassed = false，
  //      结论是「任务本身可疑」而不是「Agent 无能」
  //   2. 再用 createAlwaysRefundTarget() 与 createNeverActTarget() 各跑一次。
  //      **三个都通过 = 这条任务谁都能过，没有区分度**，trivial = true
  //   3. reason 写成人话，说清是哪一种问题（失败时把评分理由带上）
  //
  // 最后统计 brokenCount 与 trivialCount。
  void tasks
  void registry
  return {
    verdicts: tasks.map((t) => ({
      taskId: t.id,
      referencePassed: false,
      trivial: false,
      reason: 'verifySuite 未实现（练习 3）',
    })),
    brokenCount: tasks.length,
    trivialCount: 0,
  }
}
