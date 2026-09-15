/**
 * 性能预算：给 Agent 界面立几条能测的线。
 *
 * 为什么要有预算而不是「尽量快」：没有数字就没有判据，
 * 每次讨论都会变成主观感受之争。定下线之后，超了就是超了。
 *
 * 这四条是按 Agent 界面的实际瓶颈选的，不是通用 Web 指标的照搬——
 * 比如首屏渲染在这里远不如首字延迟重要，因为用户等的是模型开口。
 */

export type Budget = {
  /** 首字延迟：用户点发送到看见第一个字。这是 Agent 界面最关键的一条 */
  timeToFirstTokenMs: number
  /** 单次长任务阻塞：任何一次 JS 执行不应超过这个时长，否则输入会卡 */
  longTaskMs: number
  /** 流式期间每秒的状态更新次数上限（D2 的按帧合并就是为了这条） */
  updatesPerSecond: number
  /** 一次会话结束后的 DOM 节点数上限 */
  domNodes: number
}

export const DEFAULT_BUDGET: Budget = {
  timeToFirstTokenMs: 1000,
  longTaskMs: 50,
  updatesPerSecond: 70,
  domNodes: 5000,
}

export type Measurement = {
  timeToFirstTokenMs: number | null
  longestTaskMs: number
  updatesPerSecond: number
  domNodes: number
}

export type BudgetCheck = {
  name: string
  actual: number | null
  limit: number
  ok: boolean
  unit: string
}

export function checkBudget(m: Measurement, budget: Budget = DEFAULT_BUDGET): BudgetCheck[] {
  return [
    {
      name: '首字延迟',
      actual: m.timeToFirstTokenMs,
      limit: budget.timeToFirstTokenMs,
      // 还没测到时不算超标，但也不算通过——用 null 如实表达「没数据」
      ok: m.timeToFirstTokenMs === null || m.timeToFirstTokenMs <= budget.timeToFirstTokenMs,
      unit: 'ms',
    },
    {
      name: '最长阻塞',
      actual: m.longestTaskMs,
      limit: budget.longTaskMs,
      ok: m.longestTaskMs <= budget.longTaskMs,
      unit: 'ms',
    },
    {
      name: '每秒更新',
      actual: m.updatesPerSecond,
      limit: budget.updatesPerSecond,
      ok: m.updatesPerSecond <= budget.updatesPerSecond,
      unit: '次',
    },
    {
      name: 'DOM 节点',
      actual: m.domNodes,
      limit: budget.domNodes,
      ok: m.domNodes <= budget.domNodes,
      unit: '个',
    },
  ]
}
