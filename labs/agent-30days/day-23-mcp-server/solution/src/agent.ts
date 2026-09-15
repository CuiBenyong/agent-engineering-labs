// Agent 循环（D2 的那个循环，一行没变）。
// 唯一的区别是：工具列表不是硬编码在这里的，而是启动时从 MCP server 上「发现」来的。
import type { McpConnection } from './mcp-client'
import { complete, type ChatMessage } from './model'

const MAX_STEPS = 4

export interface AgentRun {
  answer: string
  /** 这一轮里实际发生过的 MCP tools/call，自检要拿它当证据 */
  calls: { name: string; args: Record<string, unknown>; ok: boolean; text: string }[]
}

export async function runAgent(
  question: string,
  conn: McpConnection,
  trace: (line: string) => void
): Promise<AgentRun> {
  const messages: ChatMessage[] = [{ role: 'user', content: question }]
  const calls: AgentRun['calls'] = []

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const reply = await complete(messages, conn.functionTools)
    if (!reply.toolCall) {
      trace(`[${step}] 模型收尾：${reply.text ?? ''}`)
      return { answer: reply.text ?? '', calls }
    }

    const { name, args } = reply.toolCall
    trace(`[${step}] 模型想调 ${name}(${JSON.stringify(args)})，走 MCP tools/call`)
    const outcome = await conn.callTool(name, args)
    calls.push({ name, args, ok: outcome.ok, text: outcome.text })
    trace(`    ${outcome.ok ? '成功' : '失败'}：${outcome.text}`)

    // 失败也原样回填给模型，让它自己改参数重试——D5 的错误回传口径，这里一字未改
    messages.push({
      role: 'tool',
      toolName: name,
      content: outcome.ok ? outcome.text : `[工具报错] ${outcome.text}`,
    })
  }

  return { answer: '（超过最大步数仍未收尾）', calls }
}
