import type { AgentConfig, RiskItem, TrifectaVerdict } from './core/types.js'
import { cheapestCut } from './model/trifecta.js'

const MARK = { yes: '✅ 具备', no: '—— 不具备' }

export function renderReport(
  config: AgentConfig,
  verdict: TrifectaVerdict,
  risks: RiskItem[]
): string {
  const lines: string[] = []
  lines.push(`# 威胁模型：${config.id}`)
  lines.push(config.description)
  lines.push('')
  lines.push('## 致命三件套')
  lines.push(row('访问私有数据', verdict.privateData))
  lines.push(row('接触不可信内容', verdict.untrustedContent))
  lines.push(row('能对外通信', verdict.externalComms))
  lines.push('')
  lines.push(verdict.complete ? '判定：三件套齐全，存在完整的外泄链路' : '判定：三件套未齐全')
  lines.push(`建议：${cheapestCut(verdict)}`)
  lines.push('')
  lines.push(`## 风险条目（${risks.length} 条）`)
  for (const r of risks) {
    lines.push(`- [${r.severity.toUpperCase()}] ${r.id} ${r.title}`)
    lines.push(`    OWASP：${r.owasp.join(' / ')}`)
    for (const e of r.evidence) lines.push(`    证据：${e}`)
    lines.push(`    处置：${r.mitigation}`)
  }
  return lines.join('\n')
}

function row(name: string, tools: string[]): string {
  const mark = tools.length > 0 ? MARK.yes : MARK.no
  const detail = tools.length > 0 ? `（${tools.join('、')}）` : ''
  return `- ${name}：${mark}${detail}`
}
