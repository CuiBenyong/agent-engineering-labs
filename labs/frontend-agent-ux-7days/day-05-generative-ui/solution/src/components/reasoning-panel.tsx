'use client'

import { useState } from 'react'

export type Reasoning = {
  id: string
  text: string
  streaming: boolean
}

/**
 * 推理过程面板。
 *
 * 三个设计决定：
 * 1. **默认收起**。推理是过程不是结论，默认展开会把正式答案挤到屏幕外，
 *    而多数用户多数时候只想要答案。
 * 2. **流式期间给一个活的提示**（「正在思考…」加一个计数），
 *    否则用户会觉得卡住了——推理往往是整次运行里最长的一段静默。
 * 3. **和正式回答在视觉上明确区分**。推理内容可能包含模型的试错和自我否定，
 *    读者必须一眼看出「这不是最终答案」，否则会被中间过程误导。
 */
export function ReasoningPanel({ reasoning }: { reasoning: Reasoning }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="reasoning" data-testid="reasoning-panel">
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`caret${open ? ' open' : ''}`} aria-hidden="true" />
        {reasoning.streaming ? (
          <span data-testid="reasoning-status">正在思考…（{reasoning.text.length} 字）</span>
        ) : (
          <span data-testid="reasoning-status">思考过程（{reasoning.text.length} 字）</span>
        )}
      </button>

      {open ? (
        <div className="reasoning-body" data-testid="reasoning-body">
          {reasoning.text}
        </div>
      ) : null}
    </div>
  )
}
