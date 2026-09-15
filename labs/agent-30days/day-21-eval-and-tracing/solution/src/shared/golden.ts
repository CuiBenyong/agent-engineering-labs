// 标准样本集（golden set）。15 条，不是随手抓的 15 条对话——挑选口径写在 tags 里：
// route:* 三条路由都要有人走；fanout 拆成多件并行；review-loop 会被 Critic 打回；
// budget 撞预算降级；retry-limit 打满重试上限；tool-failure 下游挂掉；fallback 路由判不准；
// incident 线上真出过事故、修完钉在这里防回归。
// 维护规矩：**只增不改**。改一条 case 的期望，历史分数就全部作废——
// 就像质检的标准样品换了批次，之前所有检测数据都没法再拿来比。

import { runRequest } from '../graph'
import { judge, PASS_SCORE, type RubricVersion, type Verdict } from './judge'
import type { RequestRecord, Span } from './observe'

export interface GoldenCase {
  id: string
  input: string
  expectRoute: 'order_lookup' | 'refund_draft' | 'smalltalk'
  /** 期望落兜底时，routingReason 必须以这个前缀开头 */
  expectFallback?: string
  /** 必备信息清单：judge 的 v2 评分标准就是它，人写一次、之后每次评估复用 */
  checklist: string[]
  tags: string[]
}

// prettier-ignore —— 15 条一行一条，改动一眼就能在 diff 里看见；散成多行反而看不出全貌
// prettier-ignore
export const GOLDEN: GoldenCase[] = [
  { id: 'g01', input: '订单 SO20260901 现在什么状态', expectRoute: 'order_lookup', checklist: ['当前阶段'], tags: ['route:order_lookup', 'happy'], },
  { id: 'g02', input: 'SO20260902 的快递到哪了', expectRoute: 'order_lookup', checklist: ['预计送达'], tags: ['route:order_lookup'], },
  { id: 'g03', input: 'SO20260901 什么状态、物流到哪了，另外这单我要退款', expectRoute: 'refund_draft', checklist: ['当前阶段', '预计送达', '退款结论'], tags: ['fanout', 'review-loop'], },
  { id: 'g04', input: 'SO20260901 未拆封，我要退款', expectRoute: 'refund_draft', checklist: ['退款结论', '建议全额退还实付金额', '未拆封 7 天内可退'], tags: ['route:refund_draft', 'review-loop'], },
  { id: 'g05', input: 'SO20260902 还没拆，能不能退货退钱', expectRoute: 'refund_draft', checklist: ['退款结论', '建议全额退还实付金额', '当前阶段'], tags: ['route:refund_draft', 'review-loop'], },
  { id: 'g06', input: '在吗？有人吗', expectRoute: 'smalltalk', checklist: ['请补充'], tags: ['route:smalltalk'], },
  { id: 'g07', input: '谢谢，你们服务挺好的', expectRoute: 'smalltalk', checklist: ['不客气'], tags: ['route:smalltalk'], },
  { id: 'g08', input: '上次那个事后来怎么样了', expectRoute: 'smalltalk', expectFallback: 'fallback:low-confidence', checklist: ['请补充'], tags: ['fallback', 'incident'], },
  { id: 'g09', input: '帮我把会员等级改一下', expectRoute: 'smalltalk', expectFallback: 'fallback:unknown-route', checklist: ['请补充'], tags: ['fallback', 'incident'], },
  { id: 'g10', input: 'SO20260901 我要开一张发票', expectRoute: 'order_lookup', checklist: ['（降级）', '预算耗尽'], tags: ['budget', 'incident'], },
  { id: 'g11', input: 'SO20260901 我要退款，还要投诉，给我一个工单号', expectRoute: 'refund_draft', checklist: ['退款结论', '（未达标）'], tags: ['retry-limit', 'fanout'], },
  { id: 'g12', input: 'SO20260901 到货包装破损，要理赔', expectRoute: 'order_lookup', checklist: ['（降级）', '理赔服务 503'], tags: ['tool-failure', 'incident'], },
  { id: 'g13', input: 'SO20260903 现在什么状态', expectRoute: 'order_lookup', checklist: ['查询中'], tags: ['edge'], },
  { id: 'g14', input: 'SO20260902 我要退款，顺便看下物流到哪了', expectRoute: 'refund_draft', checklist: ['退款结论', '预计送达', '建议全额退还实付金额'], tags: ['fanout', 'review-loop'], },
  { id: 'g15', input: '客服你好，我上周三下的单 SO20260902，家里一直没人收件，想问下现在什么状态', expectRoute: 'order_lookup', checklist: ['当前阶段', '预计送达'], tags: ['route:order_lookup', 'fanout'], },
]

// 校准集：人工逐条读完产出之后给的分（标的是「提示词被改坏之后」那一批）。judge 每改一次
// 评分提示词都要拿这 5 条对一遍——**judge 自己也要被评估**。刻意只有 5 条：人工标注很贵，
// 贵到你只能标一点点，所以它只能当尺子，不能当测试集。
export const HUMAN_LABELS: Record<string, number> = { g01: 5, g04: 1, g05: 2, g10: 5, g14: 2 }

export interface CaseResult extends RequestRecord {
  input: string
  output: string
  route: string
  routingReason: string
  verdict: Verdict
  checklist: string[]
  tags: string[]
  spans: Span[]
}

export interface RunOptions {
  rubricVersion?: RubricVersion
  judgeModel?: string
  promptVersion?: string
}

/** 跑一条：先让被评估的系统真跑一遍，再让 judge 给最终产出打分。 */
export async function runOne(item: GoldenCase, options: RunOptions = {}): Promise<CaseResult> {
  const run = await runRequest(item.id, item.input)
  const fallback = run.routingReason.startsWith('fallback:')
  const routeOk =
    run.route === item.expectRoute &&
    (item.expectFallback === undefined || run.routingReason.startsWith(item.expectFallback))
  const verdict = await judge({
    output: run.output,
    checklist: item.checklist,
    rubricVersion: options.rubricVersion,
    judgeModel: options.judgeModel,
  })
  return {
    caseId: item.id,
    input: item.input,
    output: run.output,
    route: run.route,
    routingReason: run.routingReason,
    routeOk,
    degraded: run.degraded,
    fallback,
    score: verdict.score,
    // 一条 case 算不算通过，是两件事的「与」：路由判对了，且产出达到 3 分
    pass: routeOk && verdict.score >= PASS_SCORE,
    rubricVersion: verdict.rubricVersion,
    judgeModel: verdict.judgeModel,
    promptVersion: options.promptVersion ?? 'v2',
    durationMs: run.durationMs,
    spans: run.spans,
    verdict,
    checklist: item.checklist,
    tags: item.tags,
  }
}

/** 整批跑，**一条都不能漏**：golden set 的价值就在于「改完提示词重跑同样 15 条，
 *  拿到一个能和上一次比的数字」。少跑一条，那个数字就不可比了。 */
export async function runGoldenSet(
  cases: GoldenCase[] = GOLDEN,
  options: RunOptions = {}
): Promise<CaseResult[]> {
  const results: CaseResult[] = []
  for (const item of cases) results.push(await runOne(item, options))
  return results
}

export const passed = (results: CaseResult[]): CaseResult[] => results.filter((r) => r.pass)

/** 挂了哪几条、为什么挂——通过率掉下来之后，人第一件想知道的就是这个。 */
export function failureReport(results: CaseResult[]): string[] {
  return results
    .filter((r) => !r.pass)
    .map(
      (r) =>
        `${r.caseId} [${r.tags.join(',')}] ${r.routeOk ? '' : `路由判成 ${r.route}；`}${r.score} 分 · ${r.verdict.reason}`
    )
}
