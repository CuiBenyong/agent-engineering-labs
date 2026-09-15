// 可观测的最小闭环：每次工具调用记一次耗时与是否出错，再按工具聚合。
// 指标少而准，比一堆没人看的曲线有用。出问题时先看错误率，再看 P95。
interface Sample {
  tool: string
  ms: number
  isError: boolean
}

export interface ToolStat {
  tool: string
  calls: number
  errors: number
  p50: number
  p95: number
}

export class Metrics {
  private samples: Sample[] = []

  record(tool: string, ms: number, isError: boolean): void {
    this.samples.push({ tool, ms, isError })
  }

  reset(): void {
    this.samples = []
  }

  get total(): number {
    return this.samples.length
  }

  get errors(): number {
    return this.samples.filter((s) => s.isError).length
  }

  snapshot(): ToolStat[] {
    const byTool = new Map<string, Sample[]>()
    for (const sample of this.samples) {
      const list = byTool.get(sample.tool) ?? []
      list.push(sample)
      byTool.set(sample.tool, list)
    }
    return [...byTool.entries()]
      .map(([tool, list]) => {
        const sorted = list.map((s) => s.ms).sort((a, b) => a - b)
        return {
          tool,
          calls: list.length,
          errors: list.filter((s) => s.isError).length,
          p50: quantile(sorted, 0.5),
          p95: quantile(sorted, 0.95),
        }
      })
      .sort((a, b) => b.calls - a.calls)
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return Math.round(sorted[index] * 1000) / 1000
}

export const metrics = new Metrics()
