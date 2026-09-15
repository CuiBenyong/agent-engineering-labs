// 被评估的那套系统用到的「工具」，以及它能做的几种活（技能目录）。
// 真实环境这里是商家订单系统的 HTTP 客户端；本 lab 按 SOP 写成内存实现：
// 接口形状一样、语义一样，只是数据在 Map 里。观测结果随订单号变化。
// 这一份来自 D17，本天只加了 shipping 的「收件」关键词。

export class ToolError extends Error {}

/** 一种子任务：Planner 能挑它、Executor 知道要调哪些工具、Critic 知道按什么验收。 */
export interface Skill {
  kind: string
  /** Planner 用它从请求里认出这件事该做 */
  pattern: string
  goal: string
  /** 完成它要依次调用的工具，长度就是这件事的最小成本 */
  tools: string[]
  /** Critic 的验收要求：产出里必须写明这件事 */
  requirement: string
}

// invoice 要七步而预算只有五次，注定降级；complaint 拿不到工单号，注定打满重试上限；
// damage 的下游会 503——三条都是 D17 定好的现场，今天用来给 golden set 覆盖失败模式。
// prettier-ignore
export const SKILLS: Skill[] = [
  { kind: 'order',     pattern: '订单状态|什么状态|订单进度',      goal: '查订单状态并说明当前阶段',        tools: ['查订单'], requirement: '当前阶段' },
  { kind: 'shipping',  pattern: '物流|快递|到哪|发货|签收|收件',   goal: '查物流轨迹并给出预计送达时间',    tools: ['查订单', '查物流'], requirement: '预计送达' },
  { kind: 'refund',    pattern: '退款|退货|退钱',                 goal: '依据规则拟一份退款方案，不执行退款', tools: ['查订单', '查退款规则'], requirement: '退款结论' },
  { kind: 'invoice',   pattern: '发票|开票',                      goal: '整理开票信息并提交开票申请',      tools: ['查订单', '查开票资质', '查抬头', '查税号', '查邮寄地址', '查历史开票', '生成开票申请'], requirement: '开票申请' },
  { kind: 'complaint', pattern: '投诉|升级|人工',                 goal: '把这次问题升级成人工工单并给出工单号', tools: ['建工单'], requirement: '工单号' },
  { kind: 'damage',    pattern: '破损|损坏|坏了|理赔',            goal: '发起破损理赔并回收凭证',          tools: ['查订单', '调用理赔服务'], requirement: '理赔单号' },
  { kind: 'general',   pattern: '',                               goal: '查订单基本信息并回答用户的问题',  tools: ['查订单'], requirement: '当前阶段' },
]

export const skillOf = (kind: string): Skill =>
  SKILLS.find((s) => s.kind === kind) ?? SKILLS[SKILLS.length - 1]

// prettier-ignore
const ORDERS = new Map([
  ['SO20260901', { stage: '已出库', carrier: '转运中心', eta: '明天 18:00 前', paid: 289 }],
  ['SO20260902', { stage: '待发货', carrier: '仓库备货中', eta: '后天 20:00 前', paid: 1580 }],
])

const UNKNOWN = { stage: '查询中', carrier: '暂无轨迹', eta: '暂不可估', paid: 0 }

/** 一次工具调用。耗时固定：评估要能重跑出可比较的数字，随机延迟会让 p95 每次都不一样。 */
export async function callTool(tool: string, orderId: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 4))
  const row = ORDERS.get(orderId) ?? UNKNOWN
  switch (tool) {
    case '查订单':
      return `订单 ${orderId} 当前阶段：${row.stage}，实付 ${row.paid} 元`
    case '查物流':
      return `包裹在${row.carrier}，预计送达时间 ${row.eta}`
    case '查退款规则':
      return '本单适用平台通用退货规则，未拆封 7 天内可退，运费由责任方承担'
    case '查开票资质':
      return '该店铺支持电子普通发票'
    case '查抬头':
      return '默认抬头：个人'
    case '查税号':
      return '税号已在账户资料中登记'
    case '查邮寄地址':
      return '发票发送至账号绑定邮箱'
    case '建工单':
      // 刻意给不出工单号：人工班组分配之后才回填，所以 Critic 会一直判不合格
      return '已提交人工班组，受理编号待分配'
    case '调用理赔服务':
      throw new ToolError('理赔服务 503：上游暂时不可用')
    default:
      return `工具 ${tool} 没有返回可用信息`
  }
}
