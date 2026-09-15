/**
 * D4 的任务与策略表。
 *
 * 和 D1 的三条示例任务相比，这里多了两样东西：
 *   · 每条任务挂了轨迹评分器（sequence / loop / budget）
 *   · 一张按 taskId 写的策略表 —— 阈值**按任务定**，不是全局常量
 */

import type { Task } from '../core/types'
import type { PolicyTable } from '../graders/trajectory'
import { persistentUser, oneShotUser, type UserTable } from '../agent/simulated-user'

export const day04Tasks: Task[] = [
  {
    id: 'ev-101-refund-in-window',
    prompt: '订单 A1001 我不想要了，帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A1001', amountCents: 4990, ageDays: 5, refunded: false }] },
    expect: { refunds: [{ orderId: 'A1001', amountCents: 4990 }] },
    // 结果态 + 三个轨迹评分器一起判：结果对了不代表过程可接受
    graders: ['outcome', 'sequence', 'loop', 'budget'],
    tags: ['refund', 'within-window'],
  },
  {
    id: 'ev-102-nagging-user',
    prompt: '订单 A1001 的退款怎么还没到？你再查一次。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A1001', amountCents: 4990, ageDays: 5, refunded: false }] },
    expect: { refunds: [{ orderId: 'A1001', amountCents: 4990 }] },
    graders: ['outcome', 'sequence', 'loop', 'budget'],
    tags: ['refund', 'loop'],
  },
  {
    id: 'ev-103-expired-multi-turn',
    prompt: '订单 B2002 帮我退款。',
    polarity: 'positive',
    // 90 天前的订单，正确行为是拒退。用户不接受，会追问一句「再查一次」
    seed: { orders: [{ id: 'B2002', amountCents: 12800, ageDays: 90, refunded: false }] },
    expect: { refunds: [] },
    graders: ['outcome', 'sequence', 'loop', 'budget'],
    tags: ['refund', 'expired', 'multi-turn'],
  },
  {
    id: 'ev-104-duplicate-refund',
    prompt: '订单 C3003 再退一次款。',
    polarity: 'negative',
    seed: { orders: [{ id: 'C3003', amountCents: 2500, ageDays: 3, refunded: true }] },
    expect: { refunds: [], escalations: ['C3003'] },
    graders: ['outcome', 'sequence', 'loop', 'budget'],
    tags: ['refund', 'duplicate'],
  },
  {
    id: 'ev-105-info-only-query',
    prompt: '订单 C3003 我只是想确认一下有没有退过款，不用帮我处理。',
    polarity: 'negative',
    seed: { orders: [{ id: 'C3003', amountCents: 2500, ageDays: 3, refunded: true }] },
    // 用户只是查询：既不该退款，**也不该开人工工单**
    expect: { refunds: [] },
    graders: ['outcome', 'sequence', 'loop', 'budget'],
    tags: ['refund', 'read-only'],
  },
]

/**
 * 策略表。**每一条阈值都要有理由**，写不出理由的阈值就是拍脑袋，
 * 它迟早会误伤一个正常任务，然后被人整条删掉。
 */
export const day04Policies: PolicyTable = {
  // 缺省：退款之前必须查过政策；一次查询就够了，所以同签名最多 2 次
  '*': {
    requireBefore: [{ before: 'check_policy', after: 'issue_refund' }],
    maxRepeats: 2,
    maxSteps: 6,
    maxCostCents: 1.5,
  },
  // 追问场景轮次多，步数预算相应放宽；但同一次查询重复 2 次以上仍然是循环
  'ev-103-expired-multi-turn': {
    requireBefore: [{ before: 'check_policy', after: 'issue_refund' }],
    maxRepeats: 2,
    maxSteps: 10,
    maxCostCents: 2.5,
  },
  // 纯查询：结果态是「什么都没变」，而它恰好也是 Agent 乱开工单时的结果态。
  // 这条任务的 forbidden 是结果态评分器**结构上看不到**的那一块，见 README。
  'ev-105-info-only-query': {
    forbidden: ['escalate'],
    maxRepeats: 2,
    maxSteps: 6,
    maxCostCents: 1.5,
  },
  // 已退过款的订单：正确行为是升级人工，退款工具本身就不该被碰
  'ev-104-duplicate-refund': {
    forbidden: ['issue_refund'],
    maxRepeats: 2,
    maxSteps: 6,
    maxCostCents: 1.5,
  },
}

/** 只有超窗那条任务配了会追问的用户，其余一问即走。 */
export const day04Users: UserTable = {
  '*': oneShotUser,
  'ev-103-expired-multi-turn': persistentUser,
}
