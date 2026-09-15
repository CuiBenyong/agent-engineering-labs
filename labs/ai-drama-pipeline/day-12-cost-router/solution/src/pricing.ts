// 明码标价表 + 成本台账 + 成本面板。
//
// 为什么需要这一份表：MOCK 离线模式下 provider 返回的 costCny 恒为 0（没有真的调厂商），
// 所以本实验打印的所有金额都是「按 units 乘以公开单价算出来的估算」，不是真实账单。
// 这一点在每张面板下方都会再打印一次，别把它当成对账依据。
//
// 单价来源：MiniMax 官方按量付费页（人民币）。
//
// ⚠️ 视频这几行**不要挂到任何具体模型 id 上**。按量付费页给的按秒单价属于 H3 系列（v2），
// 而本课代码统一用的是 Hailuo 系列（v1）——后者在官方是走视频点数扣减的，没有公开的按量单价。
// 两套计价口径不同，所以这张表按「档位 + 规格」计价，视频那几行是**台账演示用的折算常量**，
// 不是「某个模型每秒多少钱」。做成本台账的第一件事，就是搞清楚每一项到底按什么计价。

export type RateId = 'video-768p' | 'video-2k' | 'video-480p' | 'image' | 'tts'

export type Rate = {
  id: RateId
  label: string
  /** 计价单位：视频按秒、图像按张、语音按计费字符 */
  unit: 'second' | 'item' | 'character'
  cnyPerUnit: number
  /** true 表示这条不是官方直接标出的按量单价，只是折算值 */
  approx: boolean
  note?: string
}

export const RATES: Record<RateId, Rate> = {
  'video-768p': {
    id: 'video-768p',
    label: '视频 MiniMax-H3 768P',
    unit: 'second',
    cnyPerUnit: 0.5,
    approx: false,
  },
  'video-2k': {
    id: 'video-2k',
    label: '视频 MiniMax-H3 2K',
    unit: 'second',
    cnyPerUnit: 0.8,
    approx: false,
  },
  'video-480p': {
    id: 'video-480p',
    label: '视频 MiniMax-H3-Max 480P',
    unit: 'second',
    cnyPerUnit: 0.33,
    approx: false,
  },
  image: { id: 'image', label: '图像 image-01', unit: 'item', cnyPerUnit: 0.025, approx: false },
  tts: {
    id: 'tts',
    label: '语音 speech 系列',
    unit: 'character',
    cnyPerUnit: 0.00035,
    approx: true,
    note: '官方只公开资源包价，这里是按 HD 套餐折算的每字符单价（约每万字符三元多），不是官方标价',
  },
}

/** 文本环节故意不进这张表：官方按量单价以控制台为准，本实验只统计 token 数，不给金额。 */
export const TEXT_UNPRICED_NOTE = '文本：只统计 token，不计价（单价以官方控制台为准）'

export type LedgerRow = {
  stage: string
  provider: string
  kind: 'text' | 'image' | 'video' | 'tts'
  model: string
  units: number
  rateId: RateId | null
  estimatedCny: number
  /** 命中缓存的行不产生新花费 */
  cached: boolean
  /** 生成失败或命中安全审核的视频不扣费——这类行记账但不计费 */
  billed: boolean
  /** 单价表里没有精确匹配这条规格时，往贵了估并打上标记 */
  rateApprox: boolean
  note?: string
  at: string
}

export function estimate(rateId: RateId | null, units: number): number {
  if (!rateId) return 0
  return Number((RATES[rateId].cnyPerUnit * units).toFixed(4))
}

export class Ledger {
  readonly rows: LedgerRow[] = []

  add(row: Omit<LedgerRow, 'estimatedCny' | 'at'> & { estimatedCny?: number }): LedgerRow {
    const billable = row.billed && !row.cached
    const full: LedgerRow = {
      ...row,
      estimatedCny: billable ? (row.estimatedCny ?? estimate(row.rateId, row.units)) : 0,
      at: new Date().toISOString(),
    }
    this.rows.push(full)
    return full
  }

  get totalCny(): number {
    return round(this.rows.reduce((s, r) => s + r.estimatedCny, 0))
  }

  get savedByCacheCny(): number {
    return round(
      this.rows.filter((r) => r.cached).reduce((s, r) => s + estimate(r.rateId, r.units), 0)
    )
  }

  get unbilledCny(): number {
    return round(
      this.rows.filter((r) => !r.billed).reduce((s, r) => s + estimate(r.rateId, r.units), 0)
    )
  }
}

export function round(n: number): number {
  return Number(n.toFixed(4))
}

function bar(ratio: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  return '█'.repeat(filled) + '·'.repeat(width - filled)
}

function groupBy(rows: LedgerRow[], key: (r: LedgerRow) => string) {
  const map = new Map<string, { cny: number; calls: number; cached: number }>()
  for (const r of rows) {
    const k = key(r)
    const cur = map.get(k) ?? { cny: 0, calls: 0, cached: 0 }
    cur.cny = round(cur.cny + r.estimatedCny)
    cur.calls += 1
    cur.cached += r.cached ? 1 : 0
    map.set(k, cur)
  }
  // 同额时按名字定序，保证两次运行打印顺序完全一致。
  return [...map.entries()].sort((a, b) => b[1].cny - a[1].cny || a[0].localeCompare(b[0]))
}

/** 成本面板：按环节与按 provider 两个维度。让人一眼看出这次跑贵在哪。 */
export function printPanel(title: string, ledger: Ledger): void {
  const total = ledger.totalCny
  console.log(`\n── 成本面板：${title} ──`)
  console.log('  按环节')
  for (const [stage, v] of groupBy(ledger.rows, (r) => r.stage)) {
    const ratio = total > 0 ? v.cny / total : 0
    console.log(
      `    ${stage.padEnd(10)} ¥${v.cny.toFixed(4).padStart(8)}  ${(ratio * 100).toFixed(1).padStart(5)}%  ${bar(ratio)}  调用 ${v.calls} 次（缓存命中 ${v.cached}）`
    )
  }
  console.log('  按 provider × 类型')
  for (const [k, v] of groupBy(ledger.rows, (r) => `${r.provider}/${r.kind}`)) {
    const ratio = total > 0 ? v.cny / total : 0
    console.log(
      `    ${k.padEnd(14)} ¥${v.cny.toFixed(4).padStart(8)}  ${(ratio * 100).toFixed(1).padStart(5)}%  调用 ${v.calls} 次`
    )
  }
  console.log(`  合计（估算）¥${total.toFixed(4)}`)
  if (ledger.savedByCacheCny > 0)
    console.log(`  缓存省下（估算）¥${ledger.savedByCacheCny.toFixed(4)}`)
  if (ledger.unbilledCny > 0) {
    console.log(
      `  失败/被拦截未计费（估算）¥${ledger.unbilledCny.toFixed(4)}：失败或命中安全审核的视频不扣费`
    )
  }
  console.log(
    `  提示：MOCK 模式下没有真实调用，金额全部由 units 乘单价估算得出。${TEXT_UNPRICED_NOTE}。`
  )
  console.log(
    '  视频与语音两档单价是折算演示值（口径见 pricing.ts 顶部注释），只有图像 ¥0.025/张 是官方直接标价。'
  )
}
