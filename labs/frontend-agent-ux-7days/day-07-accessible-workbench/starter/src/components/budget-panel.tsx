'use client'

import { checkBudget, type Measurement } from '@/stream/budget'

/**
 * 性能预算面板。
 *
 * 放在界面上而不是只写在文档里，是因为**不可见的预算等于没有预算**：
 * 写在 wiki 里的性能目标没人会去查，摆在开发页面上的会被看见。
 */
export function BudgetPanel({ measurement }: { measurement: Measurement }) {
  const checks = checkBudget(measurement)

  return (
    <section className="budget" data-testid="budget-panel">
      <h2>性能预算</h2>
      {checks.map((c) => (
        <div className="budget-row" key={c.name}>
          <span>{c.name}</span>
          <span className={c.ok ? 'ok' : 'over'} data-testid={`budget-${c.ok ? 'ok' : 'over'}`}>
            <b>{c.actual === null ? '—' : c.actual}</b>
            {c.actual === null ? '' : ` / ${c.limit} ${c.unit}`}
          </span>
        </div>
      ))}
    </section>
  )
}
