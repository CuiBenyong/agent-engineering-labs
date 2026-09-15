// 一次运行的账单：把时间与钱按环节摊开。
// 这一天只负责「量出来」，怎么把它压下去是 D12 的事。

import { PRICE, type CostEntry } from './providers/index.js'
import type { NodeReport } from './dag.js'

/**
 * 离线模式下每一笔的 costCny 都是 0，那样账单没法看。
 * 所以这里按 D1 里那份官方单价把用量折算一遍，让你在没花钱的时候也能看到钱的形状。
 * 折算值只用于教学，真实账单以厂商后台为准。
 */
export function estimateCny(entry: CostEntry): number {
  // 练习 1：离线模式下每一笔的 costCny 都是 0，账单全是 ¥0.0000，看不出贵在哪。
  // 用 PRICE 里的官方单价把 entry.units 折算一遍：
  // 图按张、视频按秒、语音按计费字符，文本这一档官方没有直接单价，记 0 就行。
  // 提示：真实模式下 costCny 已经是真金白银，不要覆盖它。
  void PRICE
  return entry.costCny
}

export type BillLine = {
  nodeId: string
  title: string
  ms: number
  calls: number
  artifacts: number
  estimatedCny: number
}

export function buildBill(reports: NodeReport[], costs: CostEntry[]): BillLine[] {
  return reports.map((r) => {
    const mine = costs.filter((c) => c.nodeId === r.id)
    return {
      nodeId: r.id,
      title: r.title,
      ms: r.ms,
      calls: mine.length,
      artifacts: r.artifacts.length,
      estimatedCny: Number(mine.reduce((s, c) => s + estimateCny(c), 0).toFixed(4)),
    }
  })
}

const bar = (ratio: number) => '█'.repeat(Math.max(0, Math.round(ratio * 20)))

export function printBill(lines: BillLine[]): void {
  const totalMs = lines.reduce((s, l) => s + l.ms, 0) || 1
  const totalCny = lines.reduce((s, l) => s + l.estimatedCny, 0)
  console.log('\n账单（耗时占比 / 折算花费）')
  console.log('  环节      耗时      占比                     调用  产物    折算花费')
  for (const l of lines) {
    console.log(
      `  ${l.nodeId.padEnd(9)}${String(l.ms).padStart(6)}ms  ` +
        `${bar(l.ms / totalMs).padEnd(20)} ${String(Math.round((l.ms / totalMs) * 100)).padStart(3)}%` +
        `${String(l.calls).padStart(5)}${String(l.artifacts).padStart(6)}  ¥${l.estimatedCny.toFixed(4)}`
    )
  }
  console.log(
    `  ${'合计'.padEnd(8)}${String(totalMs).padStart(6)}ms${' '.repeat(33)}¥${totalCny.toFixed(4)}`
  )

  const slowest = [...lines].sort((a, b) => b.ms - a.ms)[0]
  const priciest = [...lines].sort((a, b) => b.estimatedCny - a.estimatedCny)[0]
  console.log(`\n  最慢的环节是 ${slowest.nodeId}，最贵的环节是 ${priciest.nodeId}。`)
  console.log('  离线模式下耗时排名不作数：视频接口被打了桩，本地 ffmpeg 反而成了大头；')
  console.log('  真实模式下 clips 一镜要排队好几分钟，会把耗时那一列彻底改写。')
  console.log('  但「最贵的是 clips」离线和真实是同一个结论，第二周的工程设计全是围着它转的。')
}
