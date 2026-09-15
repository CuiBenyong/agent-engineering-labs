/**
 * 报告产出 —— 把七天的结论收成一页能给人看的东西。
 *
 * 一条纪律：**报告里每个数字都要能回溯到它是怎么来的。**
 * 只给总分的报告没有人能复核，也就没有人会真的相信它。
 */

import type { SuiteReport } from '../core/types'
import type { HealthIssue } from './suite-health'

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

const SEVERITY_MARK: Record<HealthIssue['severity'], string> = {
  error: '✗',
  warn: '!',
  info: '·',
}

export interface ReportInput {
  report: SuiteReport
  issues: readonly HealthIssue[]
  readingList: ReadonlyArray<{ taskId: string; trialIndex: number; why: string }>
  /** 环境指纹：少了它，这份报告下周就没法和今天比 */
  fingerprint: Record<string, string | number>
}

export function renderReport(input: ReportInput): string {
  const { report, issues, readingList, fingerprint } = input
  const lines: string[] = []

  lines.push('=== 评估报告 ===')
  lines.push('')
  lines.push('-- 环境指纹（没有它这份报告不可比）--')
  for (const [k, v] of Object.entries(fingerprint)) {
    lines.push(`  ${k}: ${v}`)
  }
  lines.push('')

  lines.push('-- 分数 --')
  lines.push(`  任务数 ${report.tasks.length}　每任务 ${report.k} 次`)
  lines.push(`  pass@${report.k}  ${pct(report.passAtKRate)}`)
  lines.push(`  pass^${report.k}  ${pct(report.passHatKRate)}`)
  lines.push(`  花费 ${report.totalCostCents.toFixed(2)} 分　耗时 ${report.totalDurationMs} ms`)
  lines.push('')

  lines.push('-- 套件体检 --')
  if (issues.length === 0) {
    // 空报告本身是可疑的，要说出来而不是显示一个绿勾
    lines.push('  没有检出问题。注意这不等于套件健康——')
    lines.push('  体检器只能发现它知道怎么找的那几类问题，剩下的靠人读轨迹。')
  } else {
    const errors = issues.filter((i) => i.severity === 'error').length
    const warns = issues.filter((i) => i.severity === 'warn').length
    lines.push(`  检出 ${issues.length} 项（error ${errors}　warn ${warns}）`)
    lines.push('')
    for (const i of issues) {
      const who = i.taskId ? ` [${i.taskId}]` : ' [套件级]'
      lines.push(`  ${SEVERITY_MARK[i.severity]} ${i.kind}${who}`)
      lines.push(`      ${i.detail}`)
    }
  }
  lines.push('')

  lines.push('-- 本轮要读的轨迹 --')
  if (readingList.length === 0) {
    lines.push('  （无）')
  } else {
    for (const r of readingList) {
      lines.push(`  ${r.taskId} 第 ${r.trialIndex} 次　${r.why}`)
    }
    lines.push('')
    lines.push('  这不是建议。没有人读过轨迹之前，上面那两个百分比都只是传闻。')
  }

  return lines.join('\n')
}
