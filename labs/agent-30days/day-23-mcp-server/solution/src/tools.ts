// 领域工具：电商客服的两个只读查询（沿用本课 D5 定下的工具名与订单号形状）。
// 这一层完全不知道 MCP 的存在——它就是一组普通函数，谁想暴露它都行。
import { z } from 'zod'

export interface OrderRecord {
  status: string
  amountCny: number
  placedAt: string
  carrier: string
  shipmentTrail: string[]
}

/** 假数据库。真实实现连自己的订单库，与本课无关，所以只写两笔。 */
export const ORDERS: Record<string, OrderRecord> = {
  SO20260901: {
    status: '已发货',
    amountCny: 129,
    placedAt: '2026-09-01',
    carrier: '风驰快运',
    shipmentTrail: ['09-01 已揽收', '09-02 到达杭州转运中心', '09-03 派送中'],
  },
  SO20260902: {
    status: '待付款',
    amountCny: 88,
    placedAt: '2026-09-02',
    carrier: '未发货',
    shipmentTrail: [],
  },
}

/** 订单号的格式约束只写一遍：它同时是发给模型的说明书和执行前的校验规则（D5 的口径）。 */
const orderId = z
  .string()
  .regex(/^SO\d{8}$/, '订单号必须是 SO 开头加 8 位数字')
  .describe('订单号，SO 开头加 8 位数字，例如 SO20260901')

export const QUERY_ORDER_INPUT = { order_id: orderId }
export const TRACK_SHIPMENT_INPUT = { order_id: orderId }

export const QUERY_ORDER_DESCRIPTION =
  '按订单号查询一笔订单的状态、金额和下单时间。只查订单本身；物流轨迹请用 track_shipment。'

export const TRACK_SHIPMENT_DESCRIPTION =
  '按订单号查询这笔订单的物流轨迹与承运商。只查物流；订单状态与金额请用 query_order。'

/** 工具的返回值：ok 为 false 时 text 是给模型看的纠错说明（D5 的错误回传口径）。 */
export interface ToolOutput {
  ok: boolean
  text: string
}

function missing(id: string): ToolOutput {
  // 报错文案里带一个合法的示例订单号：模型读得懂，就能自己把参数改对，不用你写重试逻辑
  return {
    ok: false,
    text: `订单 ${id} 不存在。请向用户确认订单号；本店近期的订单号形如 SO20260901。`,
  }
}

export function queryOrder(id: string): ToolOutput {
  const order = ORDERS[id]
  if (!order) return missing(id)
  return {
    ok: true,
    text: `订单 ${id}：状态 ${order.status}，金额 ${order.amountCny} 元，下单于 ${order.placedAt}。`,
  }
}

export function trackShipment(id: string): ToolOutput {
  const order = ORDERS[id]
  if (!order) return missing(id)
  if (order.shipmentTrail.length === 0) {
    return { ok: true, text: `订单 ${id} 还没有发货，暂无物流轨迹。` }
  }
  return {
    ok: true,
    text: `订单 ${id} 由${order.carrier}承运，轨迹：${order.shipmentTrail.join('；')}。`,
  }
}
