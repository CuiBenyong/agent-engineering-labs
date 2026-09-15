// D1 实验（solution）：威胁建模器。
// 读一份 Agent 配置，判定致命三件套是否齐全，输出按严重度排序的风险条目表。
// 纯本地计算，不需要模型，也不需要网络。

import { DESKMATE, DESKMATE_NO_SEND } from './core/scenario.js'
import type { AgentConfig } from './core/types.js'
import { buildRiskItems } from './model/risks.js'
import { renderReport } from './report.js'
import { assessTrifecta } from './model/trifecta.js'

function model(config: AgentConfig): string {
  const verdict = assessTrifecta(config)
  return renderReport(config, verdict, buildRiskItems(config, verdict))
}

console.log(model(DESKMATE))
console.log('\n' + '─'.repeat(60) + '\n')
console.log('对照组：拿掉两个对外发送的工具之后，同一份配置的判定会翻转\n')
console.log(model(DESKMATE_NO_SEND))
