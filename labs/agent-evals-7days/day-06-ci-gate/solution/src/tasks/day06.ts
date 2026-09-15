/**
 * D6 的任务集：**分成两档**。
 *
 * 冒烟集（smoke）每次提交都跑，全量集（full）只在发版前跑。
 * 分档的依据不是「重要程度」，而是**覆盖面除以成本**：
 * 冒烟集要用最少的任务盖住最多的故障类别，全量集负责长尾。
 *
 * 这里的 taskSetVersion 会被写进基线快照的环境指纹。
 * 任务集改了一条，版本号就要跟着改——否则下次分数变了，
 * 你分不清是 Agent 退化了还是题目换了。
 */

import type { Task } from '../core/types'

/** 任务集版本。**改任何一条任务都必须改它。** */
export const TASK_SET_VERSION = '2026.09.14-1'

/** 冒烟档：三条，覆盖「窗口内该退」「超窗不该退」「已退过要升级」三类故障。 */
const smoke: Task[] = [
  {
    id: 'ev-001-fresh-order',
    prompt: '订单 A1001 我不想要了，帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A1001', amountCents: 4990, ageDays: 5, refunded: false }] },
    expect: { refunds: [{ orderId: 'A1001', amountCents: 4990 }] },
    graders: ['outcome'],
    tags: ['smoke', 'refund', 'within-window'],
  },
  {
    id: 'ev-002-expired-order',
    prompt: '订单 B2002 帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'B2002', amountCents: 12800, ageDays: 90, refunded: false }] },
    expect: { refunds: [] },
    graders: ['outcome'],
    tags: ['smoke', 'refund', 'expired'],
  },
  {
    id: 'ev-003-already-refunded',
    prompt: '订单 C3003 再退一次款。',
    polarity: 'negative',
    seed: { orders: [{ id: 'C3003', amountCents: 2500, ageDays: 3, refunded: true }] },
    expect: { refunds: [], escalations: ['C3003'] },
    graders: ['outcome'],
    tags: ['smoke', 'refund', 'duplicate'],
  },
]

/** 全量档在冒烟档之上再补五条长尾。 */
const extra: Task[] = [
  {
    id: 'ev-101-edge-day-30',
    prompt: '订单 D4004 刚好到期，帮我退款。',
    polarity: 'positive',
    // 第 30 天：窗口边界上，仍然应该退
    seed: { orders: [{ id: 'D4004', amountCents: 8800, ageDays: 30, refunded: false }] },
    expect: { refunds: [{ orderId: 'D4004', amountCents: 8800 }] },
    graders: ['outcome'],
    tags: ['refund', 'boundary'],
  },
  {
    id: 'ev-102-edge-day-31',
    prompt: '订单 E5005 帮我退款。',
    polarity: 'positive',
    // 第 31 天：刚过窗口，不该退
    seed: { orders: [{ id: 'E5005', amountCents: 6600, ageDays: 31, refunded: false }] },
    expect: { refunds: [] },
    graders: ['outcome'],
    tags: ['refund', 'boundary'],
  },
  {
    id: 'ev-103-unknown-order',
    prompt: '订单 F6006 帮我退款。',
    polarity: 'negative',
    // 库里没有这个订单，正确行为是什么都不退
    seed: { orders: [{ id: 'Z9999', amountCents: 100, ageDays: 1, refunded: false }] },
    expect: { refunds: [] },
    graders: ['outcome'],
    tags: ['refund', 'missing'],
  },
  {
    id: 'ev-104-high-value',
    prompt: '订单 G7007 我不想要了，帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'G7007', amountCents: 99900, ageDays: 12, refunded: false }] },
    expect: { refunds: [{ orderId: 'G7007', amountCents: 99900 }] },
    graders: ['outcome'],
    tags: ['refund', 'high-value'],
  },
  {
    id: 'ev-105-nagging-user',
    prompt: '订单 H8008 你再查一次，我要退款。',
    polarity: 'positive',
    // 用户催「再查一次」会触发靶子的重复查询缺陷（D4 抓过程，这里只看结果态）
    seed: { orders: [{ id: 'H8008', amountCents: 3200, ageDays: 9, refunded: false }] },
    expect: { refunds: [{ orderId: 'H8008', amountCents: 3200 }] },
    graders: ['outcome'],
    tags: ['refund', 'loop'],
  },
]

export const smokeTasks: Task[] = smoke
export const fullTasks: Task[] = [...smoke, ...extra]

export function pickTasks(tier: 'smoke' | 'full'): Task[] {
  return tier === 'smoke' ? smokeTasks : fullTasks
}
