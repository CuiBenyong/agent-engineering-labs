import type { AgentConfig, RiskItem, Severity, TrifectaVerdict } from '../core/types.js'

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * 把配置里的事实翻译成风险条目。
 *
 * TODO(3)：至少产出下面四类条目，并按 severity 排序返回。
 *   1. 三件套齐全时给一条 critical：R-TRIFECTA，OWASP 落在 LLM01 / LLM02 / ASI01
 *   2. 每个 returnsUntrusted 的工具一条：R-UNTRUSTED-<工具名>，
 *      三件套齐全时 high、否则 medium，OWASP 落在 LLM01 / ASI06
 *   3. 每个 effect 为 send 且不可逆的工具一条：R-IRREVERSIBLE-<工具名>，high，
 *      OWASP 落在 LLM06 / ASI02
 *   4. 每个能读私有数据的工具一条：R-PRIVATE-<工具名>，medium，OWASP 落在 LLM02 / ASI03
 *
 * evidence 必须填：威胁建模最容易写成一份没人能反驳也没人能验证的散文，
 * 带上「是哪几个工具让它成立的」才能被人当面质疑。
 */
export function buildRiskItems(config: AgentConfig, verdict: TrifectaVerdict): RiskItem[] {
  const items: RiskItem[] = []
  void config
  void verdict
  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
