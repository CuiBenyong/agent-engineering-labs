'use client'

import {
  resolveComponent,
  sanitizeNode,
  type ComponentSpec,
  type SanitizedNode,
  type UiNode,
} from '@/stream/generative'

// ---------- 范式一：注册表里的三个组件 ----------

function Metric({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="gen-metric">
      <span className="gen-metric-label">{label}</span>
      <span className="gen-metric-value">
        {value.toLocaleString()}
        {unit ? <small>{unit}</small> : null}
      </span>
    </div>
  )
}

function Choices({ question, options }: { question: string; options: string[] }) {
  return (
    <div className="gen-choices">
      <p>{question}</p>
      <div className="gen-choice-row">
        {options.map((o) => (
          <button type="button" key={o}>
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}

function Table({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="gen-table-wrap">
      <table className="gen-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 静态生成式：模型只能从注册表里挑。
 *
 * 兜底是这个组件最重要的部分——模型给了没注册过的类型时，
 * 界面必须**说清楚发生了什么**并继续工作，而不是白屏或者崩溃。
 */
export function GenerativeBlock({ spec }: { spec: ComponentSpec }) {
  const resolved = resolveComponent(spec)

  if (!resolved.ok) {
    // 两种失败分开显示，因为它们对排查的指向完全不同
    return (
      <div className="gen-fallback" data-testid="gen-fallback" data-reason={resolved.reason}>
        {resolved.reason === 'unknown-component' ? (
          <>
            <strong>这个版本还不支持「{resolved.component}」</strong>
            <p>内容已跳过，其余部分不受影响。升级应用后可能就能显示了。</p>
          </>
        ) : (
          <>
            <strong>「{resolved.component}」的数据不完整</strong>
            <p>缺少必要字段或字段类型不对，已跳过这一块。</p>
          </>
        )}
      </div>
    )
  }

  // 按组件名分派。注册表已经校验过 props，这里的断言是安全的。
  //
  // 刻意不用「组件名到函数的映射表 + 展开 props」那种写法：
  // 那需要把 props 类型放宽成 any 或 never，等于把注册表辛苦建立的
  // 类型保障又丢掉了。显式 switch 啰嗦一点，但每一支的 props 类型都是真的。
  let rendered: React.ReactElement
  switch (resolved.component) {
    case 'metric': {
      const p = resolved.props as { label: string; value: number; unit: string }
      rendered = <Metric {...p} />
      break
    }
    case 'choices': {
      const p = resolved.props as { question: string; options: string[] }
      rendered = <Choices {...p} />
      break
    }
    case 'table': {
      const p = resolved.props as { columns: string[]; rows: string[][] }
      rendered = <Table {...p} />
      break
    }
    default:
      // 注册表里有、但这里没实现。这是我们自己的 bug，不是模型的问题，
      // 所以文案要和「模型给了未注册组件」区分开。
      return (
        <div className="gen-fallback" data-testid="gen-fallback" data-reason="not-implemented">
          <strong>「{resolved.component}」尚未实现</strong>
        </div>
      )
  }

  return (
    <div className="gen-block" data-testid="gen-block" data-component={resolved.component}>
      {rendered}
    </div>
  )
}

// ---------- 范式二：声明式 ----------

function DeclarativeNode({ node }: { node: SanitizedNode }) {
  const children = node.children.map((child, i) => <DeclarativeNode key={i} node={child} />)

  switch (node.type) {
    case 'stack':
      return <div className="gen-stack">{children}</div>
    case 'row':
      return <div className="gen-row">{children}</div>
    case 'heading':
      return <h4 className="gen-heading">{node.text}</h4>
    case 'badge':
      return <span className="gen-badge">{node.text}</span>
    case 'divider':
      return <hr className="gen-divider" />
    default:
      return (
        <p className={`gen-text${node.issue ? ' gen-degraded' : ''}`} data-issue={node.issue}>
          {node.text}
          {children}
        </p>
      )
  }
}

/**
 * 声明式渲染：模型给一棵树，前端按自己的白名单和样式渲染。
 *
 * 关键是它收到的是**数据不是代码**——树里没有任何东西能被执行。
 * 这是它和开放式范式的根本区别。
 */
export function DeclarativeBlock({ tree }: { tree: UiNode }) {
  const safe = sanitizeNode(tree)
  return (
    <div className="gen-declarative" data-testid="gen-declarative">
      <DeclarativeNode node={safe} />
    </div>
  )
}
