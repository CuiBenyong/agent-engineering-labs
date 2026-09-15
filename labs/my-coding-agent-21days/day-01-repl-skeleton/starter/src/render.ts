/**
 * 终端渲染层。它只订阅 AgentEvent，完全不知道 SSE 与网关报文的存在。
 *
 * 今天故意「攒完再打」：等一轮结束才把整段回答一次性打出来，
 * 顺手把首字延迟与总耗时打在末尾——这个体感就是明天要做流式渲染的理由。
 */
import type { AgentEvent } from './kernel/types.js'

const DIM = '\u001b[2m'
const RESET = '\u001b[0m'

export interface RenderSummary {
  text: string
  firstDeltaMs: number | null
  totalMs: number
  deltas: number
}

export async function renderTurn(
  events: AsyncIterable<AgentEvent>,
  out: (line: string) => void
): Promise<RenderSummary> {
  const startedAt = Date.now()
  let text = ''
  let deltas = 0
  let firstDeltaMs: number | null = null
  let usageLine = ''

  for await (const event of events) {
    switch (event.type) {
      case 'text':
        deltas += 1
        firstDeltaMs ??= Date.now() - startedAt
        text += event.delta
        break
      case 'usage':
        usageLine = `输入 ${event.promptTokens} token，输出 ${event.completionTokens} token`
        break
      case 'error':
        out(`✗ ${event.message}`)
        break
      case 'tool_start':
      case 'tool_end':
      case 'done':
        break
    }
  }

  const totalMs = Date.now() - startedAt
  if (text) out(text)
  const stats = [
    `${deltas} 个增量`,
    firstDeltaMs === null ? '无首字' : `首字 ${firstDeltaMs}ms`,
    `总计 ${totalMs}ms`,
    usageLine,
  ]
    .filter(Boolean)
    .join(' · ')
  out(`${DIM}（${stats}）${RESET}`)
  return { text, firstDeltaMs, totalMs, deltas }
}
