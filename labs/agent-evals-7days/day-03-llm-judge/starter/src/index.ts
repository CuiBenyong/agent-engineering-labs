/**
 * evalkit CLI —— D3 版本：把裁判本身考一遍。
 *
 * 跑：
 *   MOCK=1 pnpm start
 *   MOCK=1 pnpm start -- --unbiased   # 把三种偏差都调成 0，看对照组
 *
 * 输出四段：
 *   1. 量表打分示例：裁判怎么把「回答得好」拆成三条判据
 *   2. 位置交换实验：结论翻转率与前排胜率
 *   3. 自评偏好：同一段文字换个署名会怎样
 *   4. 校准报告：准确率与 kappa 的分叉，以及这个裁判准不准上线
 */

import {
  DEFAULT_JUDGE,
  REFUND_RUBRIC,
  judgeSingle,
  scoreByRubric,
  type JudgeConfig,
} from './graders/judge'
import {
  admits,
  cohenKappa,
  runSwapExperiment,
  KAPPA_ADMISSION_THRESHOLD,
} from './graders/calibration'
import { calibrationSet, selfBiasSample, swapPairs } from './tasks/day03'

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function main(): void {
  const unbiased = process.argv.includes('--unbiased')
  const cfg: JudgeConfig = unbiased
    ? { ...DEFAULT_JUDGE, positionBias: 0, lengthBias: 0, selfBias: 0 }
    : DEFAULT_JUDGE

  console.log(
    `裁判配置：位置偏好 ${cfg.positionBias}　长度偏好 ${cfg.lengthBias}　自评偏好 ${cfg.selfBias}`
  )
  console.log(unbiased ? '（对照组：理想裁判）\n' : '（默认：带偏差的裁判）\n')

  // ---- 1. 量表打分 ----
  console.log('—— 1. 评分量表 ——')
  for (const c of REFUND_RUBRIC) {
    console.log(`  [${c.id}] ${c.name}：${c.hint}`)
  }
  // 挑一条车轱辘话当例子：量表基础分很低，全靠长度加分过线
  const demo = calibrationSet.find((s) => s.id === 'cal-28') ?? calibrationSet[0]
  const demoScore = scoreByRubric(demo.answer, REFUND_RUBRIC, cfg)
  const demoPassed = judgeSingle(demo.answer, REFUND_RUBRIC, cfg).passed
  console.log(
    `  示例 ${demo.id}（${demo.answer.text.length} 字的车轱辘话）：基础分 ${demoScore.base.toFixed(2)} + 长度 ${demoScore.lengthBonus.toFixed(2)} = ${demoScore.total.toFixed(2)} → 裁判${demoPassed ? '判通过' : '判不通过'}，人工${demo.humanPass ? '判合格' : '判不合格'}\n`
  )

  // ---- 2. 位置交换 ----
  const swap = runSwapExperiment(swapPairs, REFUND_RUBRIC, cfg)
  console.log('—— 2. 位置交换实验 ——')
  console.log(`  ${swapPairs.length} 对答案，每对正反各评一次`)
  console.log(`  前排胜率：${pct(swap.frontWinRate)}　（没有位置偏好时应该是 50.0%）`)
  console.log(`  结论翻转率：${pct(swap.flipRate)}`)
  console.log(`  合并后：${swap.decisive} 条有效结论，${swap.ties} 条判平`)
  console.log(
    `  ⚠️ 只评一轮的话，这 ${swapPairs.length} 对会给出 ${swapPairs.length} 条「有效」结论，其中 ${swap.results.filter((r) => r.flipped).length} 条是位置决定的\n`
  )

  // ---- 3. 自评偏好 ----
  const house = judgeSingle({ text: selfBiasSample, author: cfg.family }, REFUND_RUBRIC, cfg)
  const rival = judgeSingle({ text: selfBiasSample, author: 'rival' }, REFUND_RUBRIC, cfg)
  console.log('—— 3. 自评偏好 ——')
  console.log(
    `  同一段文字，署名自家：${house.score.total.toFixed(2)}　${house.passed ? '通过' : '不通过'}`
  )
  console.log(
    `  同一段文字，署名别家：${rival.score.total.toFixed(2)}　${rival.passed ? '通过' : '不通过'}`
  )
  console.log(`  通过线：${cfg.passThreshold}\n`)

  // ---- 4. 校准报告 ----
  const judgeLabels = calibrationSet.map((s) => judgeSingle(s.answer, REFUND_RUBRIC, cfg).passed)
  const humanLabels = calibrationSet.map((s) => s.humanPass)
  const real = cohenKappa(judgeLabels, humanLabels)
  // 对照裁判：什么都不看，一律判通过
  const lazy = cohenKappa(
    calibrationSet.map(() => true),
    humanLabels
  )

  console.log('—— 4. 与人工标注的一致性 ——')
  console.log(`  校准集：${real.n} 条，其中人工判合格 ${humanLabels.filter(Boolean).length} 条`)
  console.log('')
  console.log(`  本裁判　　　　准确率 ${pct(real.accuracy)}　kappa ${real.kappa.toFixed(3)}`)
  console.log(`  无脑全判通过　准确率 ${pct(lazy.accuracy)}　kappa ${lazy.kappa.toFixed(3)}`)
  console.log('')
  console.log(
    `  混淆矩阵：真通过 ${real.matrix.truePass}　假通过 ${real.matrix.falsePass}　真不通过 ${real.matrix.trueFail}　假不通过 ${real.matrix.falseFail}`
  )
  console.log('')
  console.log(
    `  准入线 kappa >= ${KAPPA_ADMISSION_THRESHOLD}：${admits(real) ? '✅ 这个裁判可以拿去拦合并' : '❌ 这个裁判还不能用来拦合并'}`
  )

  if (lazy.accuracy >= real.accuracy) {
    console.log('')
    console.log('  ⚠️ 注意：无脑全判通过的准确率比本裁判还高，但它的 kappa 是 0。')
    console.log('     如果你的准入标准是准确率，你会选中那个什么都不看的裁判。')
  }
}

main()
