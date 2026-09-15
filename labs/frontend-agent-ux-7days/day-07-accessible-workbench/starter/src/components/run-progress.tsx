'use client'

/**
 * 长任务进度：用运行阶段事件把一次运行拆成看得见的步骤。
 *
 * 注意这里刻意**不画百分比进度条**：你不知道总共有几步，
 * 假装知道会得到一个走到 90% 就卡住的进度条，那比没有更伤信任。
 * 显示「已完成的步骤 + 当前步骤」是诚实且有用的。
 */
export type StepState = { name: string; done: boolean }

export function RunProgress({ steps }: { steps: StepState[] }) {
  if (steps.length === 0) return null
  return (
    <div className="run-progress" data-testid="run-progress">
      {steps.map((s) => (
        <span key={s.name} className={s.done ? 'step done' : 'step active'}>
          {s.done ? '✓' : '●'} {s.name}
        </span>
      ))}
    </div>
  )
}
