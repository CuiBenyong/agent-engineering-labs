// 路由决策的「合同」：三个子 Agent 的名单、结构化输出的 schema、置信度阈值、兜底与 override 规则。
// 这一份是本章的核心——图怎么连是手艺，路由判错了怎么办才是判断力。
import { z } from 'zod'

/**
 * 三个子 Agent 的 id。写成 as const 才能让 z.enum 和 TypeScript 拿到字面量联合类型，
 * 于是「拼错一个路由名」在编译期就红了——自由文本路由永远做不到这一点。
 */
export const SUB_AGENTS = ['order_lookup', 'refund_draft', 'smalltalk'] as const
export type SubAgent = (typeof SUB_AGENTS)[number]

/** 兜底目标：判不准就先按最通用的部门派，宁可多问一句，也不要自信地答错。 */
export const FALLBACK_ROUTE: SubAgent = 'smalltalk'

/** 置信度阈值：低于它一律落 fallback。W3 卡片定死 0.6，D17 / D21 沿用同一个数。 */
export const CONFIDENCE_FLOOR = 0.6

/**
 * Supervisor 的结构化输出 schema。三个字段各有分工：
 * - route：只能是枚举里的三个之一，模型自造一个部门名会在这里被挡下
 * - confidence：模型对这次判断的把握，低于阈值就不采信
 * - routingReason：为什么这么判。这是整条链路里唯一能被事后审计的部分，所以设成必填
 */
export const RouteDecisionSchema = z.object({
  route: z.enum(SUB_AGENTS).describe('这一单该交给哪个子 Agent'),
  confidence: z.number().min(0).max(1).describe('对本次判断的把握，0 到 1'),
  routingReason: z.string().min(1).max(120).describe('一句话说明为什么这么判，给人看的'),
})

export type RouteDecision = z.infer<typeof RouteDecisionSchema>

/**
 * 发给模型的 JSON Schema。zod 是唯一的真相来源：
 * 同一份声明既约束了请求（模型照着它生成），又校验了响应（我们照着它解析），
 * 两边不会漂移。手写一份 schema 再手写一遍校验，迟早对不上。
 */
export const ROUTE_JSON_SCHEMA = z.toJSONSchema(RouteDecisionSchema)

/** 归一化之后的路由结果：route 一定合法，routingReason 一定有值。 */
export interface Routed {
  route: SubAgent
  confidence: number
  routingReason: string
}

function isSubAgent(value: string): value is SubAgent {
  return (SUB_AGENTS as readonly string[]).includes(value)
}

/** 把模型返回的原始 JSON 变成一个一定能用的路由结果。三种情况会落 fallback。 */
export function normalizeDecision(raw: unknown): Routed {
  const parsed = RouteDecisionSchema.safeParse(raw)

  if (!parsed.success) {
    // 结构不合法。最常见的一种是模型自造了一个不存在的部门名（比如 complaint_handler），
    // 把它单独摘出来写进 routingReason——事后你要能一眼看出「模型想去哪，但那里没人」。
    const attempted =
      raw && typeof raw === 'object' && typeof (raw as { route?: unknown }).route === 'string'
        ? (raw as { route: string }).route
        : null
    const cause = attempted ? `unknown-route(${attempted})` : 'invalid-shape'
    return {
      route: FALLBACK_ROUTE,
      confidence: 0,
      routingReason: `fallback:${cause}｜模型给的路由不在枚举里，已改派兜底`,
    }
  }

  const decision = parsed.data
  if (decision.confidence < CONFIDENCE_FLOOR) {
    // 低置信度不是「差不多就这个吧」，而是「模型自己都没把握」。
    // 派到错的子 Agent 比派不出去更糟：它会自信地给出一个错误答案，用户不会怀疑。
    return {
      route: FALLBACK_ROUTE,
      confidence: decision.confidence,
      routingReason: `fallback:low-confidence(${decision.confidence})｜模型原判 ${decision.route}：${decision.routingReason}`,
    }
  }

  return decision
}

/**
 * 最终路由 = 模型判断 + 人工 override。
 * override 优先级最高，但**不会覆盖掉模型原来的判断**：原判会被写进 routingReason，
 * 否则一周之后你就说不清「这一单是模型判错了，还是本来就被人改过」。
 */
export function resolveRoute(raw: unknown, override?: string): Routed {
  const modelSide = normalizeDecision(raw)
  if (!override) return modelSide

  if (!isSubAgent(override)) {
    // 人也会拼错。override 一样要过枚举校验，否则图会跳到一个不存在的节点，运行时才炸。
    return {
      ...modelSide,
      routingReason: `override-rejected(${override})｜不在子 Agent 名单里，仍按模型判断走｜${modelSide.routingReason}`,
    }
  }

  return {
    route: override,
    confidence: 1,
    routingReason: `override:${override}｜人工指定，模型原判 ${modelSide.route}(${modelSide.confidence})：${modelSide.routingReason}`,
  }
}
