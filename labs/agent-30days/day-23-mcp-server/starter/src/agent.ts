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

    // 练习 4：失败的时候也要把错误原文回填给模型，让它自己改参数重试
    //（D5 的错误回传口径，这里一字不用改）。约定：失败的那条前面加 "[工具报错] " 前缀。
    // 提示：下面这行把错误替换成了一句无信息量的套话——模型读不到「订单号形如 SO20260901」
    //       这句提示，就永远猜不出正确的参数，只会原地打转或者直接放弃。
    messages.push({
      role: 'tool',
      toolName: name,
      content: outcome.ok ? outcome.text : '工具调用失败。',
    })
  }

  return { answer: '（超过最大步数仍未收尾）', calls }
}
