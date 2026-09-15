// 一次跑了半小时的客服会话：用户对一笔已发货订单发起退货，中间查了订单、物流与政策，
// 还起了一张人工工单。全部为本课原创的虚构数据，不对应任何真实系统。

export type Turn = { role: 'user' | 'assistant'; text: string }

const HEAD: Turn[] = [
  { role: 'user', text: '你好，订单 SO-2026-000123 我想退，杯子还没到但我不想要了。' },
  {
    role: 'assistant',
    text: '我查了订单，已经确认状态是 shipped，订单金额 25900 分，物流单号 YT-882311907745，包裹在杭州转运中心。',
  },
  { role: 'user', text: '那能直接拦下来吗？我不想收到之后再退一次。' },
  {
    role: 'assistant',
    text: '按退换货政策 R-03，已发货订单不能中途拦截，只能签收后申请七天无理由退货，而且运费由买家承担，我不能承诺补运费。',
  },
  { role: 'user', text: '运费凭什么我出？你们发货前我就说过不要了。' },
  {
    role: 'assistant',
    text: '我理解。这一条我没有权限改，已经为你确认创建了人工工单 TK-2026-0731，由售后主管判断是否特批运费。',
  },
]

const MIDDLE: Turn[] = Array.from({ length: 22 }, (_, i) => {
  const round = i + 1
  return i % 2 === 0
    ? {
        role: 'user' as const,
        text: `第 ${round} 轮追问：那我现在还能做什么？包裹到哪一站了？之前那个杯子的替代款还有货吗？我朋友说别家可以直接拦截，你们为什么不行？`,
      }
    : {
        role: 'assistant' as const,
        text: `第 ${round} 轮回复：包裹仍在运输途中，最新一站是杭州转运中心第 ${round} 分拣线，预计还有一到两天到达。替代款目前有货，价格区间在 39 到 68 元之间。各平台的拦截能力取决于与承运商的系统对接方式，这一点我这边无法代表其它平台说明。`,
      }
})

const TAIL: Turn[] = [
  { role: 'user', text: '行吧，那工单什么时候有结果？' },
  { role: 'assistant', text: '售后主管的处理时效是一个工作日内，处理完会有短信通知你。' },
  { role: 'user', text: '我希望周五 18:00 前给个说法，不然我就去平台投诉了。' },
  { role: 'assistant', text: '好的，我把这个时间点记在工单备注里了。' },
]

export const CONVERSATION: Turn[] = [...HEAD, ...MIDDLE, ...TAIL]

/** 压缩之后必须还能在上下文里找到的事实。丢一条就是压过头了。 */
export const KEY_FACTS: { label: string; needle: string }[] = [
  { label: '订单金额（分）', needle: '25900' },
  { label: '退货政策条目编号', needle: 'R-03' },
  { label: '人工工单号', needle: 'TK-2026-0731' },
  { label: '用户要求的答复时限', needle: '周五 18:00' },
]
