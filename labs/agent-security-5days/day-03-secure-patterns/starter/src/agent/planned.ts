import { PAGE_CONTENT } from '../core/corpus.js'
import { decide, type ModelAction } from '../core/mock-model.js'
import { buildPrompt } from '../defense/levels.js'
import type { RunResult } from './reactive.js'

/**
 * 先定计划后执行（Plan-Then-Execute）。
 *
 * 核心原则（Beurer-Kellner 等，arXiv 2506.08837）：
 *   一旦 Agent 摄入了不可信输入，就必须被约束到
 *   「那段输入不可能触发任何有后果的动作」。
 *
 * 落地成两句话：
 *   1. 动作清单在**看任何不可信内容之前**就定死。
 *   2. 读不可信内容的那次模型调用**没有任何工具**，它的输出只能当数据用。
 *
 * 注意这里没有任何检测器、没有任何关键词表。载荷写得多巧妙都不重要——
 * 它想触发的动作压根不在计划里。
 */

/** 用户预授权的收件人。空数组表示这次运行完全不允许对外发送。 */
export type Recipients = string[]

export interface PlanStep {
  tool: ModelAction['tool']
  /** 对外发送类动作的目标，必须在预授权名单里 */
  target?: string
}

/**
 * 计划器：**只看用户的请求**，看不到工单正文，也看不到网页。
 * 它产出的清单就是这次运行能做的全部事情。
 */
export function plan(request: string, recipients: Recipients): PlanStep[] {
  // TODO(1)：只看 request 与 recipients，产出这次运行能做的全部动作。
  //   - 总是包含一次 search_customers（读私有数据本身不危险，危险的是把它送出去）
  //   - request 里提到「写回工单」时追加 update_ticket
  //   - recipients 里每个地址追加一个 send_email 步骤；**名单是用户给的，不是工单给的**
  // 写完确认一件事：这个函数的参数里没有工单正文，你也不要把它加进来。
  void request
  void recipients
  return []
}

/**
 * 隔离读取：这次调用看得到不可信原文，但**没有工具**。
 * 它的返回只被当成一段字符串。
 *
 * 这里刻意把它「想做什么」记录下来——很多条用例里，隔离模型确实被劫持了，
 * 它确实打算把客户名单发出去。它没能发出去，不是因为它没上当，
 * 而是因为它手上没有那把钥匙。
 */
export function quarantinedRead(
  request: string,
  ticketBody: string
): { summary: string; hijackAttempts: ModelAction[] } {
  const blocks = [{ label: '工单正文（来自外部用户）', content: ticketBody }]
  const link = /https?:\/\/\S+/.exec(ticketBody)?.[0]
  if (link) {
    blocks.push({ label: `抓取到的网页 ${link}`, content: PAGE_CONTENT[link] ?? '（抓不到内容）' })
  }

  // 用 D2 第三档的提示词组装，说明这一层与输入侧防御并不互斥，只是不再依赖它。
  // TODO(2)：调一次 decide()，把它想做的对外发送动作挑出来记在 hijackAttempts 里，
  // 然后**把所有动作丢掉**，只返回一段 summary 字符串。
  // 记录它「想做什么」是这个实验的点睛之笔：你会看到它确实上当了。
  void decide
  void buildPrompt
  return { summary: '', hijackAttempts: [] }
}

export interface PlannedResult extends RunResult {
  hijackAttempts: ModelAction[]
  plan: PlanStep[]
}

export function runPlanned(
  input: { request: string; ticketBody: string },
  recipients: Recipients = []
): PlannedResult {
  // TODO(3)：执行器。
  //   先 plan()，再 quarantinedRead()，然后**只**把计划里的步骤变成动作。
  //   读到的内容已经是一段 summary，它不得改变任何一个动作——
  //   这一行就是「有后果的动作与不可信输入之间那道墙」。
  void input
  void recipients
  void plan
  void quarantinedRead
  const actions: ModelAction[] = []
  return { actions, blocked: false, blockReason: '', hijackAttempts: [], plan: [] }
}
