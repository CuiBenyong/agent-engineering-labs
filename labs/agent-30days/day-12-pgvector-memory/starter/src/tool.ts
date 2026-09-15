import { searchMemories } from './memory'
import type { SearchHit, Store } from './infra/store'

export const DEFAULT_LIMIT = 5
export const MAX_LIMIT = 10
// 低于这个相似度宁可不返回，也不要拿噪声去污染上下文。
// 0.3 是 text-embedding-3-small 上的经验值，**不是一个可移植的常数**：换 embedding 模型、
// 换 chunk 大小都要在自己的数据上重新标定。MOCK=1 的假向量尺度更是另一回事——
// 实测无关 query 也能拿到 0.29-0.36，所以离线跑的时候这条下限几乎不拦人，
// 别把 MOCK 里试出来的阈值搬上线。自检第 5 项验「空结果」用的是换一个没有记忆的用户，
// 而不是靠低分过滤，就是这个原因。
export const MIN_SCORE = 0.3

export type ToolArgs = Record<string, unknown>
export interface AgentContext {
  store: Store
  userId: string // 身份只来自会话上下文，绝不做成工具参数
}

// 工具定义照 D5 的规矩写：格式说明 + 合法示例 + 上下界全部进 schema。
// 注意 properties 里没有 user_id——把身份做成参数，等于把「查谁的记忆」交给一段
// 概率生成的文本，一句提示词注入就是现成的越权读取漏洞。
export const memorySearchTool = {
  name: 'memory_search',
  description:
    '在这位用户的长期记忆里按语义检索沉淀下来的事实与偏好。' +
    '只查跨会话的长期记忆；本次会话说过的话直接看上文，不要用这个工具。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '用一句自然语言描述你想回忆什么，例如 用户的食物忌口' },
      limit: {
        type: 'integer',
        description: `返回条数，1 到 ${MAX_LIMIT} 之间的整数，默认 ${DEFAULT_LIMIT}`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ['query'],
  },
}

/**
 * 练习 3：按 D5 的工具协议校验参数，返回全部错误（不是报了第一条就返回）。
 * 要挡住三类：query 缺失、query 不是非空字符串、limit 不是 1 到 MAX_LIMIT 的整数。
 * 提示：每条错误都要有「字段名 + 期望范围 + 一个合法示例 + 你传的是什么」四件东西，
 *   模型才可能一次改对；limit 超上限要报错让它改，不要静默截断成 10——
 *   静默截断的话模型永远学不会自己传错了。
 * 现在什么都不校验：跑自检你会看到 limit=50 被原样放行。
 */
export function validateArgs(args: ToolArgs): string[] {
  void args
  void DEFAULT_LIMIT
  void MAX_LIMIT
  return []
}

/**
 * 练习 4：把命中结果排成返回给模型的文本。三件事都要做到：
 *   一、命中为空时返回一句明确的「没有找到相关的长期记忆，请不要凭空推测」——
 *       返回空串，模型会当成「没有约束」，然后凭印象编一条用户偏好出来；
 *   二、把相似度分数和日期一起给模型，它才能区分「你说过」和「我印象里你好像提过」；
 *   三、一条记忆一行，正文里的换行要先压平，否则模型和你的日志都分不清有几条。
 * 现在只把正文拼起来：跑自检你会看到空结果那一项是 ❌。
 */
export function formatHits(hits: SearchHit[]): string {
  return hits.map((hit) => hit.content).join('\n')
}

export async function runMemorySearch(args: ToolArgs, ctx: AgentContext): Promise<string> {
  const errors = validateArgs(args)
  if (errors.length > 0) {
    // 错误是数据不是异常：包成一条 tool 消息回给模型，让它自己改参数重来（D5）
    return `调用失败。${errors.join('；')}。请修正后重新调用 memory_search。`
  }

  const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT
  const hits = await searchMemories(ctx.store, ctx.userId, String(args.query), limit)
  return formatHits(hits.filter((hit) => hit.score >= MIN_SCORE))
}
