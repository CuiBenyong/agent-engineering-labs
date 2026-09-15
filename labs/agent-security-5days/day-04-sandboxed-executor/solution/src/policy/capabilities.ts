import { DESKMATE_TOOLS } from '../core/scenario.js'
import type { ToolSpec } from '../core/types.js'

/**
 * 危险等级：能力面的三个字段（effect / sensitivity / reversible）算出来的，
 * 不是人工一个个拍的。人工拍的清单会在加新工具时静默过期——
 * 加了工具没人改清单，它就默认落进最宽松的那一档。
 */
export type RiskTier = 'safe' | 'sensitive' | 'dangerous'

export function riskTier(tool: ToolSpec): RiskTier {
  if (tool.effect === 'send' && !tool.reversible) return 'dangerous'
  if (tool.effect === 'send' || tool.effect === 'write') return 'sensitive'
  if (tool.sensitivity === 'private') return 'sensitive'
  return 'safe'
}

const BY_NAME = new Map(DESKMATE_TOOLS.map((t) => [t.name, t]))

export function lookup(name: string): ToolSpec | undefined {
  return BY_NAME.get(name)
}

export function capabilityTable(): string {
  const lines = ['工具              作用   敏感度    可逆   危险等级']
  lines.push('─'.repeat(56))
  for (const t of DESKMATE_TOOLS) {
    lines.push(
      `${t.name.padEnd(18)}${t.effect.padEnd(7)}${t.sensitivity.padEnd(10)}` +
        `${(t.reversible ? '是' : '否').padEnd(6)}${riskTier(t)}`
    )
  }
  return lines.join('\n')
}
