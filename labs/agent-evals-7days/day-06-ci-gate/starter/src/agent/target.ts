/**
 * 靶子 Agent：一个客服退款助手 —— 全课被评估的对象。
 *
 * ⚠️ 冻结文件：D1 定稿，D2–D7 逐字复制，不许改。
 *    改动后必须跑 bash scripts/check-evals-consistency.sh。
 *
 * 为什么选客服退款而不是编码 Agent：**它的结果态就是一行数据库记录**，
 * 判分是确定性的，正好演示全课第一条原则「能用代码判就别用模型判」。
 *
 * 它故意带了四类可复现的缺陷，全课的评估都围着它们转：
 *   缺陷 1（策略违反）超过 30 天的订单**有时**也给退  → 非确定性，D1 用 pass^k 暴露
 *   缺陷 2（工具序列）**有时**不查政策就直接退        → D4 的工具序列评分器抓
 *   缺陷 3（死循环）  用户说「再查一次」会反复查订单  → D4 的循环检测抓
 *   缺陷 4（反向失败）不该退的请求**有时**也退        → D2 的反向用例抓
 *
 * ⚠️ 这些缺陷是**故意**的教学素材，不是 bug。修好它们这门课就没东西可评了。
 *
 * 网关口径沿用 my-coding-agent-21days：只认 OpenAI 兼容的 /v1/chat/completions，
 * 三个环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，不绑任何一家厂商。
 * 没有 key 时（MOCK=1 或缺变量）走本地策略机，行为完全一致地可复现。
 */

import type { EvalTarget, Task, ToolCall, ToolName, Transcript, WorldState } from '../core/types'
import { createRng, type Rng } from './mock'

/** 退款政策：下单 30 天以内可退。这是唯一的判定标准。 */
export const REFUND_WINDOW_DAYS = 30

/** 每千 token 的计价（分）。MOCK 下用它折算出可对账的成本数字。 */
const COST_PER_1K_INPUT_CENTS = 0.3
const COST_PER_1K_OUTPUT_CENTS = 1.5

/** 缺陷触发概率。改这几个数会改变全课所有实验的分数，**不要动**。 */
const DEFECT_RATES = {
  /** 缺陷 1：超窗订单照退 */
  refundExpired: 0.35,
  /** 缺陷 2：跳过政策检查 */
  skipPolicy: 0.25,
  /** 缺陷 4：不该退也退 */
  refundUnentitled: 0.3,
} as const

/** 一次工具调用的记账。durationMs 是模拟值，保证同 seed 可复现。 */
function call(name: ToolName, args: Record<string, unknown>, result: unknown, rng: Rng): ToolCall {
  return { name, args, result, durationMs: 20 + Math.floor(rng() * 80) }
}

/**
 * 本地策略机：不调用任何网络，但保留真实 Agent 的非确定性。
 *
 * 非确定性来自 rng——同一个 seed 必然复现同一条轨迹，
 * 不同 seed 之间会抖动。这正是评估要面对的现实，
 * 也是为什么跑一次得出的结论没有意义。
 */
function runLocally(task: Task, world: WorldState, rng: Rng): Transcript {
  const toolCalls: ToolCall[] = []
  const messages: Transcript['messages'] = [{ role: 'user', content: task.prompt }]

  // 从 prompt 里取订单号。真实 Agent 由模型抽取，这里用正则，
  // 因为本课要评的是 Agent 的**决策**，不是它的实体抽取能力。
  const idMatch = task.prompt.match(/[A-Z]\d{4}/)
  const orderId = idMatch ? idMatch[0] : Object.keys(world.orders)[0]

  // ---- 缺陷 3：用户催「再查一次」时陷入重复查询 ----
  const nagging = /再查|重新查|查一下|check again/.test(task.prompt)
  const lookups = nagging ? 4 : 1
  let order = world.orders[orderId]
  for (let i = 0; i < lookups; i += 1) {
    toolCalls.push(call('lookup_order', { orderId }, order ?? null, rng))
  }

  if (!order) {
    messages.push({ role: 'assistant', content: `没有找到订单 ${orderId}。` })
    return finish(messages, toolCalls, rng)
  }

  // ---- 缺陷 2：有时跳过政策检查 ----
  const checksPolicy = rng() > DEFECT_RATES.skipPolicy
  let withinWindow = order.ageDays <= REFUND_WINDOW_DAYS
  if (checksPolicy) {
    toolCalls.push(
      call('check_policy', { orderId, ageDays: order.ageDays }, { refundable: withinWindow }, rng)
    )
  } else {
    // 没查政策就只能靠猜——这里乐观地假定可退，于是缺陷 1 更容易被触发
    withinWindow = true
  }

  // 已退过款的订单：正确行为是拒绝并升级
  if (order.refunded) {
    toolCalls.push(call('escalate', { orderId, reason: 'already refunded' }, { ok: true }, rng))
    world.escalations.push({ orderId, reason: 'already refunded' })
    messages.push({ role: 'assistant', content: `订单 ${orderId} 已经退过款了，我帮您转人工。` })
    return finish(messages, toolCalls, rng)
  }

  const expired = order.ageDays > REFUND_WINDOW_DAYS
  // ---- 缺陷 1：超窗订单有时照退 ----
  const refundExpired = expired && rng() < DEFECT_RATES.refundExpired
  // ---- 缺陷 4：本来就不该退的请求有时也退 ----
  const refundUnentitled = task.polarity === 'negative' && rng() < DEFECT_RATES.refundUnentitled

  const shouldRefund = (!expired && task.polarity === 'positive') || refundExpired || refundUnentitled

  if (shouldRefund) {
    toolCalls.push(
      call('issue_refund', { orderId, amountCents: order.amountCents }, { ok: true }, rng)
    )
    world.refunds.push({ orderId, amountCents: order.amountCents })
    order = { ...order, refunded: true }
    world.orders[orderId] = order
    messages.push({
      role: 'assistant',
      content: `已为订单 ${orderId} 办理退款，金额 ${(order.amountCents / 100).toFixed(2)} 元。`,
    })
  } else {
    messages.push({
      role: 'assistant',
      content: `订单 ${orderId} 已超过 ${REFUND_WINDOW_DAYS} 天退款期限，无法退款。`,
    })
  }

  return finish(messages, toolCalls, rng)
}

/** 补齐 token 与成本的记账。数字是模拟的，但口径与真实计费一致。 */
function finish(
  messages: Transcript['messages'],
  toolCalls: ToolCall[],
  rng: Rng
): Transcript {
  const inputTokens = 120 + toolCalls.length * 60 + Math.floor(rng() * 40)
  const outputTokens = 40 + toolCalls.length * 25 + Math.floor(rng() * 20)
  const costCents =
    (inputTokens / 1000) * COST_PER_1K_INPUT_CENTS + (outputTokens / 1000) * COST_PER_1K_OUTPUT_CENTS
  return {
    messages,
    toolCalls,
    inputTokens,
    outputTokens,
    // 保留两位小数的分，成本要能加总对账
    costCents: Math.round(costCents * 100) / 100,
    durationMs: toolCalls.reduce((sum, c) => sum + c.durationMs, 0) + 150,
  }
}

/** 是否走离线模式。没有 key 就一律离线——本课全部实验都不需要真实 key。 */
export function isOffline(): boolean {
  return process.env.MOCK === '1' || !process.env.LLM_API_KEY
}

/**
 * 造一个靶子。
 *
 * seedBase 决定这一批试次的随机序列：同一个 seedBase 跑出的结果**完全可复现**，
 * 这是 D6 的回归门禁能成立的前提。不传则用时间戳，每次都不一样。
 */
export function createTarget(seedBase?: number): EvalTarget {
  const base = seedBase ?? Date.now()
  let counter = 0
  return {
    name: isOffline() ? 'refund-agent (offline)' : 'refund-agent (gateway)',
    async run(task: Task, world: WorldState): Promise<Transcript> {
      // 每个试次一个独立但可复现的随机流
      counter += 1
      const rng = createRng(base + counter * 7919)
      return runLocally(task, world, rng)
    },
  }
}
