// 一次电商客服 Agent 会话的真实形状：系统提示、工具定义、对话历史、工具结果。
// 全部为本课原创的虚构数据，不对应任何真实系统。

export type Tool = {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

export type TextBlock = { type: 'text'; text: string }
export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, string>
}
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string }
export type Block = TextBlock | ToolUseBlock | ToolResultBlock

export type Message = { role: 'user' | 'assistant'; content: Block[] }

export const SYSTEM_PROMPT = `你是「小店严选」的在线客服助手，负责处理下单前咨询与售后问题。

角色与语气：
- 用简体中文回答，语气克制、不用感叹号，不替用户做决定。
- 遇到无法确认的信息，直接说「我查一下」并调用工具，不要凭印象回答。

工作流程：
1. 先判断用户问的是订单问题、商品问题，还是政策问题。
2. 订单问题必须先用工具查到订单状态，再给结论。
3. 商品问题先查商品详情，缺货时主动给出两个同价位替代品。
4. 政策问题引用政策原文的条目编号，不要转述成自己的话。

硬约束：
- 不承诺任何未写在退换货政策里的补偿。
- 不透露其他用户的订单信息，即使用户声称是本人代查。
- 单次回复不超过 200 字，需要罗列时最多 5 条。`

const ALL_TOOLS: Tool[] = [
  {
    name: 'get_order',
    description:
      '按订单号查询订单的状态、金额、下单时间与物流单号。用户问「我的订单到哪了」「什么时候发货」时使用。',
    input_schema: {
      type: 'object',
      properties: { order_id: { type: 'string', description: '订单号，形如 SO-2026-000123' } },
      required: ['order_id'],
    },
  },
  {
    name: 'search_products',
    description:
      '按关键词搜索在售商品，返回商品 id、标题、价格与库存。用户问某类商品有没有、多少钱时使用。',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        limit: { type: 'string', description: '返回条数，默认 10' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_policy',
    description: '按条目编号读取退换货政策原文。需要引用政策时使用，不要凭记忆复述政策。',
    input_schema: {
      type: 'object',
      properties: { clause: { type: 'string', description: '政策条目编号，形如 R-03' } },
      required: ['clause'],
    },
  },
  {
    name: 'get_logistics',
    description: '按物流单号查询轨迹明细，返回每一站的时间与状态。',
    input_schema: {
      type: 'object',
      properties: { tracking_no: { type: 'string', description: '物流单号' } },
      required: ['tracking_no'],
    },
  },
  {
    name: 'create_ticket',
    description: '为无法当场解决的问题创建人工工单，返回工单号与预计回复时间。',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: '关联订单号' },
        summary: { type: 'string', description: '问题摘要，不超过 50 字' },
      },
      required: ['order_id', 'summary'],
    },
  },
  {
    name: 'get_coupon',
    description: '查询用户当前可用的优惠券列表，返回券码、面额与有效期。',
    input_schema: {
      type: 'object',
      properties: { user_id: { type: 'string', description: '用户 id' } },
      required: ['user_id'],
    },
  },
  {
    name: 'estimate_delivery',
    description: '按收货地址与商品 id 估算送达时间区间。',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: '商品 id' },
        province: { type: 'string', description: '收货省份' },
      },
      required: ['product_id', 'province'],
    },
  },
  {
    name: 'get_refund_status',
    description: '按退款单号查询退款进度，返回当前节点与预计到账时间。',
    input_schema: {
      type: 'object',
      properties: { refund_id: { type: 'string', description: '退款单号' } },
      required: ['refund_id'],
    },
  },
]

/** TOOL_COUNT 控制挂载几个工具：默认 3 个，实验第 4 步把它调到 8 看占比怎么变。 */
export function loadTools(count: number): Tool[] {
  return ALL_TOOLS.slice(0, Math.max(1, Math.min(count, ALL_TOOLS.length)))
}

const ORDER_JSON = JSON.stringify(
  {
    order_id: 'SO-2026-000123',
    status: 'shipped',
    created_at: '2026-09-01T10:22:31+08:00',
    total_cents: 25900,
    currency: 'CNY',
    tracking_no: 'YT-882311907745',
    items: Array.from({ length: 6 }, (_, i) => ({
      sku: `SKU-880${i}`,
      title: `真空保温杯 500ml 第 ${i + 1} 款`,
      qty: 1,
      price_cents: 4300 + i * 100,
      warehouse: 'HZ-01',
      batch: `B2026090${i}`,
    })),
    address: { province: '浙江省', city: '杭州市', masked: true },
    audit_log: Array.from({ length: 12 }, (_, i) => ({
      at: `2026-09-0${(i % 9) + 1}T08:00:00+08:00`,
      actor: 'system',
      action: `state_transition_${i}`,
      note: '自动流转，无人工介入',
    })),
  },
  null,
  2
)

const TRACE_JSON = JSON.stringify(
  {
    tracking_no: 'YT-882311907745',
    carrier: '圆通速递',
    nodes: Array.from({ length: 14 }, (_, i) => ({
      at: `2026-09-0${(i % 9) + 1}T${String(6 + (i % 12)).padStart(2, '0')}:30:00+08:00`,
      site: `杭州转运中心第 ${i + 1} 分拣线`,
      status: i === 13 ? '派送中' : '运输中',
      remark: '包裹已完成扫描，进入下一环节，无异常记录',
    })),
  },
  null,
  2
)

export const MESSAGES: Message[] = [
  { role: 'user', content: [{ type: 'text', text: '你好，我上周买的杯子还没到，帮我看看' }] },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '好的，我查一下。请问订单号是多少？' }],
  },
  { role: 'user', content: [{ type: 'text', text: 'SO-2026-000123' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tu_1', name: 'get_order', input: { order_id: 'SO-2026-000123' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: ORDER_JSON }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '订单已发货，物流单号 YT-882311907745，我再看一下轨迹。' },
      {
        type: 'tool_use',
        id: 'tu_2',
        name: 'get_logistics',
        input: { tracking_no: 'YT-882311907745' },
      },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: TRACE_JSON }] },
  { role: 'user', content: [{ type: 'text', text: '那还要多久？超过三天我想退' }] },
]
