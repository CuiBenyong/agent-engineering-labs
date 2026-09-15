import type { AgentConfig, RiskItem, Severity, TrifectaVerdict } from '../core/types.js'

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * 把配置里的事实翻译成风险条目。
 * 每条都必须带 evidence——威胁建模最容易写成一份没人能反驳也没人能验证的散文，
 * 带上「是哪几个工具让它成立的」才能被人当面质疑。
 */
export function buildRiskItems(config: AgentConfig, verdict: TrifectaVerdict): RiskItem[] {
  const items: RiskItem[] = []

  if (verdict.complete) {
    items.push({
      id: 'R-TRIFECTA',
      title: '致命三件套齐全：一次间接注入即可完成数据外泄',
      severity: 'critical',
      owasp: ['LLM01 提示注入', 'LLM02 敏感信息泄露', 'ASI01 目标劫持'],
      evidence: [
        `私有数据：${verdict.privateData.join('、')}`,
        `不可信内容：${verdict.untrustedContent.join('、')}`,
        `外部通信：${verdict.externalComms.join('、')}`,
      ],
      mitigation: '拆掉任意一条边；拆不掉就把外部通信收进确认门与出口白名单',
    })
  }

  for (const tool of config.tools) {
    if (tool.returnsUntrusted) {
      items.push({
        id: `R-UNTRUSTED-${tool.name}`,
        title: `${tool.name} 的返回内容是不可信输入，会直接进上下文`,
        severity: verdict.complete ? 'high' : 'medium',
        owasp: ['LLM01 提示注入', 'ASI06 记忆与上下文投毒'],
        evidence: [tool.description],
        mitigation: '给返回内容打来源标记，并保证它不能改变后续动作',
      })
    }
    if (tool.effect === 'send' && !tool.reversible) {
      items.push({
        id: `R-IRREVERSIBLE-${tool.name}`,
        title: `${tool.name} 是不可逆的对外动作，出错没有第二次机会`,
        severity: 'high',
        owasp: ['LLM06 过度代理权', 'ASI02 工具滥用'],
        evidence: [tool.description],
        mitigation: '加确认门，并限制收件人与目标地址的白名单',
      })
    }
    if (tool.sensitivity === 'private' && tool.effect === 'read') {
      items.push({
        id: `R-PRIVATE-${tool.name}`,
        title: `${tool.name} 能读到私有数据，检索范围没有按调用者收窄`,
        severity: 'medium',
        owasp: ['LLM02 敏感信息泄露', 'ASI03 身份与权限滥用'],
        evidence: [tool.description],
        mitigation: '改成按当前用户身份检索，而不是用一份全量凭据',
      })
    }
  }

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
