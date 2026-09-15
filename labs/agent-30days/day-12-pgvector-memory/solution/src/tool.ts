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

/** 校验一次报全，别报了第一条就返回——这直接决定模型要重试几轮。 */
export function validateArgs(args: ToolArgs): string[] {
  const errors: string[] = []
  const query = args.query
  if (query === undefined) {
    errors.push('缺少必填参数 query')
  } else if (typeof query !== 'string' || query.trim().length === 0) {
    errors.push(
      `参数 query 需要一句非空的检索语句，例如 用户的食物忌口；你传的是 ${JSON.stringify(query)}`
    )
  }

  const limit = args.limit
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit)) {
      errors.push(`参数 limit 需要整数，例如 ${DEFAULT_LIMIT}；你传的是 ${JSON.stringify(limit)}`)
    } else if (limit < 1 || limit > MAX_LIMIT) {
      // 不静默截断成 10：静默截断的话模型永远学不会自己传错了
      errors.push(
        `参数 limit 超出范围：需要 1 到 ${MAX_LIMIT} 之间的整数，` +
          `例如 ${DEFAULT_LIMIT}；你传的是 ${limit}`
      )
    }
  }

  return errors
}

/** 返回给模型的文本。空结果必须说出口，相似度分数也要一起给。 */
export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    // 返回空串，模型会把它当成「没有约束」，然后凭印象编一条用户偏好出来
    return '没有找到相关的长期记忆。请不要凭空推测用户的偏好，可以直接向用户确认。'
  }
  // 一条记忆一行：正文里可能带换行，先压平，否则模型（和你的日志）分不清有几条
  return hits
    .map(
      (hit, index) =>
        `${index + 1}. [相似度 ${hit.score.toFixed(2)}｜${hit.createdAt.slice(0, 10)}] ` +
        hit.content.replace(/\s+/g, ' ')
    )
    .join('\n')
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
