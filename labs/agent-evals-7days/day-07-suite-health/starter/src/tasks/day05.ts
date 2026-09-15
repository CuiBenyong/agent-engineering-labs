/**
 * D5 的四条任务。**这不是基准集**（那是 D2 的事），
 * 只要够把面板的四行填满、并且各行的失败率明显不同就行。
 */

import type { Task } from '../core/types'

export const day05Tasks: Task[] = [
  {
    id: 'ev-001-fresh-order',
    prompt: '订单 A1001 我不想要了，帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A1001', amountCents: 4990, ageDays: 5, refunded: false }] },
    expect: { refunds: [{ orderId: 'A1001', amountCents: 4990 }] },
    graders: ['outcome'],
    tags: ['refund', 'within-window'],
  },
  {
    id: 'ev-002-expired-order',
    prompt: '订单 B2002 帮我退款。',
    polarity: 'positive',
    // 90 天前的订单，超窗不该退 —— 缺陷 1 会让它偶尔退，失败率在面板上最高
    seed: { orders: [{ id: 'B2002', amountCents: 12800, ageDays: 90, refunded: false }] },
    expect: { refunds: [] },
    graders: ['outcome'],
    tags: ['refund', 'expired'],
  },
  {
    id: 'ev-003-already-refunded',
    prompt: '订单 C3003 再退一次款。',
    polarity: 'negative',
    seed: { orders: [{ id: 'C3003', amountCents: 2500, ageDays: 3, refunded: true }] },
    expect: { refunds: [], escalations: ['C3003'] },
    graders: ['outcome'],
    tags: ['refund', 'duplicate'],
  },
  {
    id: 'ev-004-nagging-user',
    prompt: '订单 D4004 到底怎么回事，你再查一次。',
    polarity: 'positive',
    // 用户催「再查一次」会触发缺陷 3：重复查订单。
    // 它在结果态上完全正确，只有链路里的工具 span 条数能看出不对劲 ——
    // 这一条专门用来演示「面板上的工具调用次数是一个独立的信号」。
    seed: { orders: [{ id: 'D4004', amountCents: 8800, ageDays: 10, refunded: false }] },
    expect: { refunds: [{ orderId: 'D4004', amountCents: 8800 }] },
    graders: ['outcome'],
    tags: ['refund', 'loop'],
  },
]
