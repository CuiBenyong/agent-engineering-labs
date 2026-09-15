/**
 * D1 的三条示例任务。**这不是基准集** —— 完整的基准集是 D2 的事。
 * 这里只要够演示「同一个任务跑五次、分数会抖」就行。
 */

import type { Task } from '../core/types'

export const day01Tasks: Task[] = [
  {
    id: 'ev-001-fresh-order',
    prompt: '订单 A1001 我不想要了，帮我退款。',
    polarity: 'positive',
    // 5 天前的订单，在 30 天窗口内，应该退
    seed: { orders: [{ id: 'A1001', amountCents: 4990, ageDays: 5, refunded: false }] },
    expect: { refunds: [{ orderId: 'A1001', amountCents: 4990 }] },
    graders: ['outcome'],
    tags: ['refund', 'within-window'],
  },
  {
    id: 'ev-002-expired-order',
    prompt: '订单 B2002 帮我退款。',
    polarity: 'positive',
    // 90 天前的订单，超出窗口，**不应该**退 —— 靶子的缺陷 1 会让它偶尔退
    seed: { orders: [{ id: 'B2002', amountCents: 12800, ageDays: 90, refunded: false }] },
    expect: { refunds: [] },
    graders: ['outcome'],
    tags: ['refund', 'expired'],
  },
  {
    id: 'ev-003-already-refunded',
    prompt: '订单 C3003 再退一次款。',
    polarity: 'negative',
    // 已经退过款，正确行为是拒绝并升级人工
    seed: { orders: [{ id: 'C3003', amountCents: 2500, ageDays: 3, refunded: true }] },
    expect: { refunds: [], escalations: ['C3003'] },
    graders: ['outcome'],
    tags: ['refund', 'duplicate'],
  },
]
