// 一次运行的目录布局与成本台账。全课统一，后面每天都复制这一份。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CostEntry } from './providers/index.js'

export const WORK_DIR = process.env.WORK_DIR ?? 'work'

/**
 * 真实模式下的产物是**花过钱的**，而 `work/` 是随时会被清理的临时产物区
 * （仓库根 .gitignore 忽略它，仓库测试也要求它是空的）。这两个身份放在同一个目录里，
 * 早晚会有人——包括写这门课的人——用一条 rm 把付费素材清掉。已经发生过一次。
 * 所以真实模式请把产物写到仓库外：
 *   WORK_DIR=~/drama-out pnpm start
 * 这个函数在启动时提醒一次，不阻断运行。
 */
export function warnIfPaidOutputInRepo(): void {
  if (process.env.MOCK === '1') return
  if (process.env.WORK_DIR) return
  console.warn(
    '⚠️  真实模式的产物会写进仓库内的 work/，那里随时会被清理脚本删掉。\n' +
      '   建议改成：WORK_DIR=~/drama-out pnpm start —— 花过钱的素材不该放在临时目录里。'
  )
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const seq = p(Math.floor(now.getHours() * 60 + now.getMinutes()) % 1000, 3)
  return `run-${stamp}-${seq}`
}

export class Run {
  readonly dir: string
  readonly costs: CostEntry[] = []

  constructor(readonly id: string) {
    this.dir = join(WORK_DIR, 'runs', id)
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts)
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  record(entry: Omit<CostEntry, 'runId' | 'at'>): void {
    this.costs.push({ ...entry, runId: this.id, at: new Date().toISOString() })
  }

  get totalCny(): number {
    return Number(this.costs.reduce((s, c) => s + c.costCny, 0).toFixed(4))
  }

  async save(extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      this.path('run.json'),
      JSON.stringify(
        { runId: this.id, totalCny: this.totalCny, costs: this.costs, ...extra },
        null,
        2
      ),
      'utf8'
    )
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}
