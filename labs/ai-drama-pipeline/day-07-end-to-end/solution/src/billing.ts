// 一次运行的账单：把时间与钱按环节摊开。
// 这一天只负责「量出来」，怎么把它压下去是 D12 的事。

import { PRICE, type CostEntry } from './providers/index.js'
import type { NodeReport } from './dag.js'

/**
 * 离线模式下每一笔的 costCny 都是 0，那样账单没法看。
 * 所以这里用 D1 的 PRICE 常量把用量折算一遍，让你在没花钱的时候也能看到钱的形状。
 * 三个数字的口径要说清楚：图像是官方直接标价；视频用的是官方按量付费页上的**档位价**，
 * 不是某个具体模型的标价（本课代码用的那一档官方走的是点数扣减）；语音是由资源包折算的近似值。
 * **折算值只用于教学，真实账单以厂商后台为准。**
 */
export function estimateCny(entry: CostEntry): number {
  if (entry.costCny > 0) return entry.costCny
  switch (entry.kind) {
    case 'image':
      return entry.units * PRICE.imagePerItem
    case 'video':
      return entry.units * PRICE.videoPerSecond
    case 'tts':
      return entry.units * PRICE.ttsPerCharacter
    default:
      return 0
  }
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
  console.log('  环节           耗时      占比                    调用  产物    折算花费')
  for (const l of lines) {
    console.log(
      `  ${l.nodeId.padEnd(13)}${String(l.ms).padStart(6)}ms  ` +
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
