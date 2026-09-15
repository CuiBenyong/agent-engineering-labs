import { CONTEXT_BUDGET, MULTI_HOP_BUDGET } from './metrics'
import type { Candidate, Retriever } from './retrieve'
import { fuseCandidates } from './retrieve'
import {
  bridgeQuery,
  classifyIntent,
  hydeQuery,
  multiQuery,
  rewriteQuery,
  stepBackQuery,
  type Intent,
  type Turn,
} from './transforms'

/**
 * 把五种手法拼成一条可开关的查询管道。
 *
 * 每一项都是一个布尔开关，因为**这一天的产出不是「全都打开」，而是一份默认配置**。
 * 要证明某一项该默认打开，只能把它单独打开跑一遍评估，再看三笔账划不划算。
 */

export interface PipelineConfig {
  rewrite: boolean
  hyde: boolean
  multiQuery: boolean
  stepBack: boolean
  router: boolean
  /** 路由认出多跳之后给它更高的上下文预算。false 时三条路共用同一个预算 */
  budgetByIntent?: boolean
}

export const BASELINE: PipelineConfig = {
  rewrite: false,
  hyde: false,
  multiQuery: false,
  stepBack: false,
  router: false,
}

export const withOnly = (key: keyof PipelineConfig): PipelineConfig => ({
  ...BASELINE,
  [key]: true,
})

export interface QueryResult {
  candidates: Candidate[]
  /** 模型调用次数：改写、假设文档、多路查询、后退提问、意图分类各算一次 */
  modelCalls: number
  /** 检索次数：每个检索式跑一遍算一次。多路查询是这一项涨得最快的手法 */
  retrievals: number
  intent: Intent | null
  queries: string[]
  notes: string[]
  /** 这一问实际拿到的上下文预算。算指标时要用它，不能一律按 600 算 */
  budget: number
}

/**
 * 跑一个问题。顺序是有讲究的，别随手调换：
 *
 * 1. **先改写，再路由。** 「这个人叫什么名字」在改写前是个指代未消解的句子，
 *    路由看它只能瞎猜；改写成「平台组组长叫什么名字」之后，路由才有东西可判。
 * 2. **扩展类手法（多路 / 后退 / 假设文档）都建立在改写后的那句话上**，
 *    否则你会把一个没消解的指代扩展成三份没消解的指代，错误被放大三倍。
 * 3. **融合放在最后**，用 D9 的倒数排名融合，同分按 id 兜底排序。
 */
export async function runQuery(
  retriever: Retriever,
  rawQuery: string,
  history: Turn[],
  cfg: PipelineConfig
): Promise<QueryResult> {
  const notes: string[] = []
  let modelCalls = 0
  let query = rawQuery

  if (cfg.rewrite) {
    const step = await rewriteQuery(rawQuery, history)
    query = step.value
    modelCalls += step.calls
    notes.push(step.note)
  }

  let intent: Intent | null = null
  if (cfg.router) {
    const step = await classifyIntent(query)
    intent = step.value
    modelCalls += step.calls
    notes.push(step.note)
    if (intent === 'direct') {
      // 分流的全部价值就在这一行：这类问题一次检索都不发，也就没有上下文成本
      notes.push('走直接回答，本轮零次检索')
      return {
        candidates: [],
        modelCalls,
        retrievals: 0,
        intent,
        queries: [],
        notes,
        budget: 0,
      }
    }
  }

  const queries = [query]
  if (cfg.multiQuery) {
    const step = await multiQuery(query)
    modelCalls += step.calls
    notes.push(step.note)
    for (const v of step.value) if (!queries.includes(v)) queries.push(v)
  }
  if (cfg.stepBack) {
    const step = await stepBackQuery(query)
    modelCalls += step.calls
    notes.push(step.note)
    if (!queries.includes(step.value)) queries.push(step.value)
  }
  if (cfg.hyde) {
    const step = await hydeQuery(query)
    modelCalls += step.calls
    notes.push(step.note)
    // 假设文档是作为**第二个检索式**参与融合，而不是替换掉原问题。
    // 经典 HyDE 是直接替换的；这里保留原问题，是因为模型编歪时替换会把原问题的信号一起丢掉，
    // 而融合最多是稀释。这个取舍要在正文里讲清楚。
    if (!queries.includes(step.value)) queries.push(step.value)
  }

  const results: Candidate[][] = []
  for (const q of queries) results.push(await retriever.retrieve(q))
  let candidates = results.length === 1 ? results[0] : fuseCandidates(results)
  let retrievals = queries.length

  if (intent === 'multi-hop') {
    // 多跳：拿第一轮的正文找一个桥（角色名或《文档交叉引用》），再查一轮，两轮融合。
    // 完整的多轮检索（模型自己决定要不要再查）是第十二天的内容，这里只做够用的一版。
    const contextText = candidates
      .slice(0, 5)
      .map((c) => c.chunk.text)
      .join('\n')
    const bridge = bridgeQuery(query, contextText)
    if (bridge) {
      notes.push(`多跳第二轮：${bridge}`)
      const second = await retriever.retrieve(bridge)
      retrievals += 1
      candidates = fuseCandidates([candidates, second])
    } else {
      notes.push('多跳：第一轮结果里没找到桥接线索，退回单跳')
    }
  }

  const budget = cfg.budgetByIntent && intent === 'multi-hop' ? MULTI_HOP_BUDGET : CONTEXT_BUDGET
  return { candidates, modelCalls, retrievals, intent, queries, notes, budget }
}
