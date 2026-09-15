import type { AgentConfig, TrifectaVerdict } from '../core/types.js'

/**
 * 致命三件套判据（Simon Willison, 2025-06）：
 * 访问私有数据 + 接触不可信内容 + 能对外通信，三者同时具备时，
 * 一次成功的提示注入就能变成一次数据外泄。
 *
 * TODO(1)：按下面三条规则填出三个数组，并算出 complete。
 *   - privateData：sensitivity 为 private 的工具名
 *   - untrustedContent：returnsUntrusted 为 true 的工具名；
 *     另外，如果 config.userInputTrust 是 untrusted，追加一项 '<用户输入>'
 *   - externalComms：effect 为 send 的工具名
 *
 * 想清楚一件事再动手：这里判的是**能力**不是**行为**。
 * 工具清单里有，就算具备——攻击者能不能用上它，不取决于你平时用不用它。
 */
export function assessTrifecta(config: AgentConfig): TrifectaVerdict {
  const privateData: string[] = []
  const untrustedContent: string[] = []
  const externalComms: string[] = []

  void config

  return {
    privateData,
    untrustedContent,
    externalComms,
    complete: false,
  }
}

/**
 * TODO(2)：三条边里拆掉哪一条最省？
 * 按「涉及的工具数」升序排，返回代价最小的那条边的建议文案。
 * 三件套未齐全时直接返回「三件套未齐全，当前没有完整的外泄链路」。
 */
export function cheapestCut(verdict: TrifectaVerdict): string {
  void verdict
  return 'TODO'
}
