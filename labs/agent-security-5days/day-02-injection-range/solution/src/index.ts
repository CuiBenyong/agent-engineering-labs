// D2 实验（solution）：注入靶场。
// 同一批用例跑在四档输入侧防御下，输出攻击成功率（ASR）与正常任务完成率（utility）对照表。
//
// 离线运行，不需要模型也不需要网络：模型由 src/core/mock-model.ts 的机械规则扮演。
// 加 --adaptive 会把那条专门绕过检测器的自适应用例也算进去。

import { ADAPTIVE_CASES, ATTACK_CASES } from './core/corpus.js'
import { renderTable, scoreAll } from './harness/score.js'

const withAdaptive = process.argv.includes('--adaptive')
const attacks = withAdaptive ? [...ATTACK_CASES, ...ADAPTIVE_CASES] : ATTACK_CASES

console.log(renderTable(scoreAll(attacks), attacks.length))
console.log('')

if (withAdaptive) {
  console.log('已计入自适应用例 A-10：它把发送动词与地址拆到两行，检测器的特征就失效了。')
  console.log('输入侧到此为止——剩下的这条，只能靠 D3 的架构级防御。')
} else {
  console.log('再跑一次 pnpm start --adaptive，看加入一条自适应用例之后 L4 的 ASR 会怎样。')
}
