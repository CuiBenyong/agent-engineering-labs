import type { AgentConfig, TrifectaVerdict } from '../core/types.js'

/**
 * 致命三件套判据（Simon Willison, 2025-06）：
 * 访问私有数据 + 接触不可信内容 + 能对外通信，三者同时具备时，
 * 一次成功的提示注入就能变成一次数据外泄。
 *
 * 注意这里判的是**能力**而不是**行为**：只要工具清单里有，它就算具备，
 * 因为攻击者能不能用上它，不取决于你平时用不用它。
 */
export function assessTrifecta(config: AgentConfig): TrifectaVerdict {
  const privateData = config.tools.filter((t) => t.sensitivity === 'private').map((t) => t.name)

  // 不可信内容有两个来源：工具返回的外部内容，以及用户输入本身。
  const untrustedContent = config.tools.filter((t) => t.returnsUntrusted).map((t) => t.name)
  if (config.userInputTrust === 'untrusted') untrustedContent.push('<用户输入>')

  const externalComms = config.tools.filter((t) => t.effect === 'send').map((t) => t.name)

  return {
    privateData,
    untrustedContent,
    externalComms,
    complete: privateData.length > 0 && untrustedContent.length > 0 && externalComms.length > 0,
  }
}

/** 三条边里拆掉哪一条最省：返回按「涉及工具数」升序排的建议。 */
export function cheapestCut(verdict: TrifectaVerdict): string {
  if (!verdict.complete) return '三件套未齐全，当前没有完整的外泄链路'
  const edges: Array<[string, number]> = [
    ['私有数据访问', verdict.privateData.length],
    ['不可信内容', verdict.untrustedContent.length],
    ['外部通信', verdict.externalComms.length],
  ]
  edges.sort((a, b) => a[1] - b[1])
  return `拆「${edges[0][0]}」这条边代价最小，只涉及 ${edges[0][1]} 处`
}
