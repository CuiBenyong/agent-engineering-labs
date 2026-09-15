// 子任务用到的「工具」。真实环境这里是商家订单系统的 HTTP 客户端，
// 本 lab 按 SOP 的口径写成内存实现：接口形状一样，语义一样，只是数据在 Map 里。
// 观测结果随订单号变化——换一个订单号，下面每一条工具返回都会跟着变。

export class ToolError extends Error {}

interface OrderRow {
  stage: string
  carrier: string
  eta: string
  paid: number
  taxId: string
}

const ORDERS = new Map<string, OrderRow>([
  [
    'SO20260901',
    {
      stage: '已出库',
      carrier: '转运中心',
      eta: '明天 18:00 前',
      paid: 289,
      taxId: '91310000MA1K0000XT',
    },
  ],
  [
    'SO20260902',
    {
      stage: '待发货',
      carrier: '仓库备货中',
      eta: '后天 20:00 前',
      paid: 1580,
      taxId: '91310000MA1K0000XT',
    },
  ],
])

const FALLBACK: OrderRow = {
  stage: '查询中',
  carrier: '暂无轨迹',
  eta: '暂不可估',
  paid: 0,
  taxId: '待补充',
}

function rowOf(orderId: string): OrderRow {
  return ORDERS.get(orderId) ?? FALLBACK
}

/** 一次工具调用。返回一行观测文本，供 Executor 攒起来交给模型润色。 */
export async function callTool(tool: string, orderId: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 25)))
  const row = rowOf(orderId)
  switch (tool) {
    case '查订单':
      return `订单 ${orderId} 当前阶段：${row.stage}，实付 ${row.paid} 元`
    case '查物流':
      return `包裹在${row.carrier}，预计送达时间 ${row.eta}`
    case '查配送状态':
      return `${row.stage}，收货地址在出库后不可自助修改，可改派到附近自提点`
    case '查退款规则':
      return `本单适用平台通用退货规则，未拆封 7 天内可退，运费由责任方承担`
    case '查开票资质':
      return `该店铺支持电子普通发票`
    case '查抬头':
      return `默认抬头：个人`
    case '查税号':
      return `税号 ${row.taxId}`
    case '查邮寄地址':
      return `发票发送至账号绑定邮箱`
    case '查历史开票':
      return `该订单历史开票记录：无`
    case '生成开票申请':
      return `开票申请已生成，24 小时内发送`
    case '建工单':
      // 刻意给不出工单号：人工班组分配之后才回填。Critic 要的正是这个号，所以它会一直判不合格。
      return `已提交人工班组，受理编号待分配`
    case '调用理赔服务':
      // 模拟一个真会挂的下游：并行时它必须只拖垮自己这一条子任务
      throw new ToolError('理赔服务 503：上游暂时不可用')
    default:
      return `工具 ${tool} 没有返回可用信息`
  }
}
