// 一个电商客服 Agent 连续调用五次工具之后，攒在上下文里的工具结果。
// 全部为本课原创的虚构数据，不对应任何真实系统。

export type ToolResult = {
  ref: string
  tool: string
  args: string
  content: string
}

const bigOrder = JSON.stringify(
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
      supplier_code: `SUP-${1000 + i}`,
      shelf: `A-${i}-12`,
    })),
    address: { province: '浙江省', city: '杭州市', masked: true },
    audit_log: Array.from({ length: 18 }, (_, i) => ({
      at: `2026-09-0${(i % 9) + 1}T08:00:00+08:00`,
      actor: 'system',
      action: `state_transition_${i}`,
      note: '自动流转，无人工介入，本条记录仅供内部审计使用',
    })),
    internal_flags: { risk_score: 0.02, fraud_check: 'passed', channel: 'app', ab_bucket: 'B' },
  },
  null,
  2
)

const searchResults = JSON.stringify(
  {
    keyword: '保温杯',
    total: 214,
    items: Array.from({ length: 20 }, (_, i) => ({
      product_id: `P-${9000 + i}`,
      title: `不锈钢真空保温杯 ${400 + i * 20}ml 第 ${i + 1} 款`,
      price_cents: 3900 + i * 150,
      stock: i % 4 === 0 ? 0 : 30 + i,
      rating: 4.2 + (i % 7) * 0.1,
      review_count: 100 + i * 37,
      description: '双层不锈钢内胆，六小时保温，杯盖可拆洗，附赠杯刷一支，适合日常通勤与户外使用。',
      images: [
        `https://example.invalid/p/${9000 + i}/1.jpg`,
        `https://example.invalid/p/${9000 + i}/2.jpg`,
      ],
    })),
  },
  null,
  2
)

const traceJson = JSON.stringify(
  {
    tracking_no: 'YT-882311907745',
    carrier: '圆通速递',
    latest_status: '派送中',
    nodes: Array.from({ length: 16 }, (_, i) => ({
      at: `2026-09-0${(i % 9) + 1}T${String(6 + (i % 12)).padStart(2, '0')}:30:00+08:00`,
      site: `杭州转运中心第 ${i + 1} 分拣线`,
      status: i === 15 ? '派送中' : '运输中',
      remark: '包裹已完成扫描，进入下一环节，无异常记录，操作员工号已脱敏',
    })),
  },
  null,
  2
)

const policyJson = JSON.stringify(
  {
    clause: 'R-03',
    title: '签收前拒收与七天无理由退货',
    text: '商品签收之日起七日内，商品保持完好且不影响二次销售的，可申请无理由退货，运费由买家承担。',
    updated_at: '2026-07-01',
  },
  null,
  2
)

const freshOrder = JSON.stringify(
  {
    order_id: 'SO-2026-000123',
    status: 'shipped',
    total_cents: 25900,
    tracking_no: 'YT-882311907745',
    updated_at: '2026-09-06T09:10:00+08:00',
    items: Array.from({ length: 6 }, (_, i) => ({
      sku: `SKU-880${i}`,
      title: `真空保温杯 500ml 第 ${i + 1} 款`,
      qty: 1,
      price_cents: 4300 + i * 100,
      warehouse: 'HZ-01',
      batch: `B2026090${i}`,
      supplier_code: `SUP-${1000 + i}`,
      shelf: `A-${i}-12`,
    })),
    audit_log: Array.from({ length: 18 }, (_, i) => ({
      at: `2026-09-0${(i % 9) + 1}T09:00:00+08:00`,
      actor: 'system',
      action: `sync_${i}`,
      note: '与仓储系统对账，无差异',
    })),
    internal_flags: { risk_score: 0.02, fraud_check: 'passed', channel: 'app', ab_bucket: 'B' },
  },
  null,
  2
)

const hugeLog = [
  'GET /api/orders/SO-2026-000123 200 12ms',
  ...Array.from(
    { length: 600 },
    (_, i) =>
      `2026-09-06T09:${String(i % 60).padStart(2, '0')}:00 INFO  worker-3 handled job ${i} in ${8 + (i % 40)}ms, queue depth ${i % 17}`
  ),
].join('\n')

export function loadToolResults(huge: boolean): ToolResult[] {
  const base: ToolResult[] = [
    { ref: 'tr_1', tool: 'get_order', args: 'order_id=SO-2026-000123', content: bigOrder },
    { ref: 'tr_2', tool: 'search_products', args: 'keyword=保温杯', content: searchResults },
    { ref: 'tr_3', tool: 'get_logistics', args: 'tracking_no=YT-882311907745', content: traceJson },
    { ref: 'tr_4', tool: 'get_policy', args: 'clause=R-03', content: policyJson },
    { ref: 'tr_5', tool: 'get_order', args: 'order_id=SO-2026-000123', content: freshOrder },
  ]
  if (!huge) return base
  return [...base, { ref: 'tr_6', tool: 'read_log', args: 'service=order-api', content: hugeLog }]
}

/** 裁剪之后必须还能在上下文里找到的关键事实。找不到就说明裁过头了。 */
export const KEY_FACTS: { label: string; needle: string }[] = [
  { label: '订单状态是已发货', needle: 'shipped' },
  { label: '物流单号', needle: 'YT-882311907745' },
  { label: '订单金额（分）', needle: '25900' },
  { label: '退货政策条目编号', needle: 'R-03' },
]
