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
  // 练习 2：把「模型说什么就是什么」换成两道闸门，任一不过就落 FALLBACK_ROUTE。
  //   闸门一（枚举）：用 RouteDecisionSchema.safeParse(raw) 校验结构。不通过时，
  //     若 raw.route 是个字符串，把它写成 `fallback:unknown-route(那个名字)`，
  //     否则写 `fallback:invalid-shape`——事后要能一眼看出「模型想去哪，但那里没人」。
  //   闸门二（置信度）：低于 CONFIDENCE_FLOOR 时改派兜底，理由写成
  //     `fallback:low-confidence(0.42)｜模型原判 xxx：原因`，把模型的原判留在里面。
  // 提示：派到错的子 Agent 比派不出去更糟——它会自信地给出一个错误答案，用户不会怀疑。
  // 下面这个默认实现正是本章要批判的那种：模型说什么就是什么，连名字对不对都不看。
  const guess = (raw ?? {}) as Partial<RouteDecision>
  return {
    route: (guess.route as SubAgent) ?? FALLBACK_ROUTE,
    confidence: guess.confidence ?? 0,
    routingReason: guess.routingReason ?? '(模型没给理由)',
  }
}

/**
 * 最终路由 = 模型判断 + 人工 override。
 * override 优先级最高，但**不会覆盖掉模型原来的判断**：原判会被写进 routingReason，
 * 否则一周之后你就说不清「这一单是模型判错了，还是本来就被人改过」。
 */
export function resolveRoute(raw: unknown, override?: string): Routed {
  const modelSide = normalizeDecision(raw)
  // 练习 3：让 override 真的生效。
  //   1. 没传 override 就照模型的判断走。
  //   2. 传了但不在名单里（人也会拼错），用 isSubAgent 挡下来，理由写
  //      `override-rejected(那个名字)｜…`，仍按模型判断走——不要让图跳到一个不存在的节点。
  //   3. 合法的 override 直接改派，理由写成
  //      `override:目标｜人工指定，模型原判 xxx(0.88)：原因`。
  // 提示：**不要丢掉模型的原判**。一周之后你要能回答「这一单是模型判错了，还是本来就被人改过」，
  // 只有把两边都写进 routingReason 才答得出来。
  void override // 现在 override 被直接忽略：值班领导改派了，系统当没看见
  return modelSide
}
