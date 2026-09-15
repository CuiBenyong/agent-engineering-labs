/**
 * D7 的体检素材：一个**故意不健康**的套件。
 *
 * 六条任务各自演示一类问题，外加两条正常任务作对照。
 * 直接拿一个健康套件做体检，报告会是空的，那什么也教不了。
 */

import type { Task } from '../core/types'

export const day07Tasks: Task[] = [
  // --- 正常对照：会抖，有信息量 ---
  {
    id: 'ev-701-normal',
    prompt: '订单 A7001 我不想要了，帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A7001', amountCents: 4990, ageDays: 5, refunded: false }] },
    expect: { refunds: [{ orderId: 'A7001', amountCents: 4990 }] },
    graders: ['outcome'],
    tags: ['healthy'],
  },
  // --- 饱和：靶子永远做得对，连续多轮满分 ---
  {
    id: 'ev-702-saturated',
    prompt: '订单 A7002 帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A7002', amountCents: 1000, ageDays: 1, refunded: false }] },
    expect: { refunds: [{ orderId: 'A7002', amountCents: 1000 }] },
    graders: ['outcome'],
    tags: ['saturated'],
  },
  // --- 坏任务：prompt 里的订单号根本不在 seed 里，谁来都过不了 ---
  {
    id: 'ev-703-broken',
    prompt: '订单 Z9999 帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A7003', amountCents: 2000, ageDays: 2, refunded: false }] },
    expect: { refunds: [{ orderId: 'Z9999', amountCents: 2000 }] },
    graders: ['outcome'],
    tags: ['broken'],
  },
  // --- 判分缺陷：任务本身没问题，坏的是挂在它上面的评分器 ---
  {
    id: 'ev-704-grading-defect',
    prompt: '订单 A7004 帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A7004', amountCents: 4990, ageDays: 3, refunded: false }] },
    expect: { refunds: [{ orderId: 'A7004', amountCents: 4990 }] },
    graders: ['strict-amount'],
    tags: ['grading-defect'],
  },
  // --- 同一条任务，换成正确的评分器作对照 ---
  {
    id: 'ev-705-grading-fixed',
    prompt: '订单 A7005 帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A7005', amountCents: 4990, ageDays: 3, refunded: false }] },
    expect: { refunds: [{ orderId: 'A7005', amountCents: 4990 }] },
    graders: ['correct-amount'],
    tags: ['grading-fixed'],
  },
  // --- 会抖的任务：超窗订单，靶子的缺陷 1 让它时对时错 ---
  // 套件里**必须**有会抖的任务，否则每次运行分数都一样，
  // 「基线是否有代表性」这个问题根本无从谈起（分布退化成一个点）。
  {
    id: 'ev-706-flaky',
    prompt: '订单 A7006 帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A7006', amountCents: 8800, ageDays: 90, refunded: false }] },
    expect: { refunds: [] },
    graders: ['outcome'],
    tags: ['flaky', 'expired'],
  },
  // --- 反向用例：已退过款的订单不能再退，应该升级人工 ---
  {
    id: 'ev-707-negative',
    prompt: '订单 A7007 再退一次款。',
    polarity: 'negative',
    seed: { orders: [{ id: 'A7007', amountCents: 3000, ageDays: 4, refunded: true }] },
    expect: { refunds: [], escalations: ['A7007'] },
    graders: ['outcome'],
    tags: ['negative'],
  },
]
