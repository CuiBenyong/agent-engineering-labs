'use client'

/**
 * 共享状态面板。
 *
 * 这是 Agent 界面区别于聊天界面的关键：有些进展根本不属于对话。
 * 一个正在被填写的表单、一份逐步成形的报告、一个走到第三步的流程——
 * 把它们塞进聊天气泡是别扭的，它们需要自己的一块地方，并且会原地更新。
 */

type Step = { name: string; done: boolean }

function isStepArray(value: unknown): value is Step[] {
  return (
    Array.isArray(value) &&
    value.every((s) => typeof s === 'object' && s !== null && 'name' in s && 'done' in s)
  )
}

export function StateInspector({
  state,
  stale,
}: {
  state: Record<string, unknown> | null
  stale?: boolean
}) {
  if (!state) {
    return (
      <aside className="state-panel empty" data-testid="state-panel">
        <h2>共享状态</h2>
        <p className="hint">还没有收到状态快照。</p>
      </aside>
    )
  }

  const steps = isStepArray(state.steps) ? state.steps : null
  const metrics =
    typeof state.metrics === 'object' && state.metrics !== null
      ? (state.metrics as Record<string, unknown>)
      : null

  return (
    <aside className="state-panel" data-testid="state-panel">
      <h2>共享状态</h2>

      {/* 补丁打不上、正在等重新对齐时，要明确告诉用户这份数据可能过期了，
          而不是若无其事地继续显示。显示一份可能错的数据比显示「正在同步」更糟。 */}
      {stale ? (
        <p className="state-stale" data-testid="state-stale">
          与服务端不同步，正在重新对齐…
        </p>
      ) : null}

      {typeof state.task === 'string' ? <p className="state-task">{state.task}</p> : null}

      {steps ? (
        <ol className="state-steps" data-testid="state-steps">
          {steps.map((s, i) => (
            <li key={i} className={s.done ? 'done' : ''}>
              <span className="tick" aria-hidden="true">
                {s.done ? '✓' : '○'}
              </span>
              {s.name}
            </li>
          ))}
        </ol>
      ) : null}

      {metrics && Object.keys(metrics).length > 0 ? (
        <dl className="state-metrics" data-testid="state-metrics">
          {Object.entries(metrics).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </aside>
  )
}
