/**
 * 自检：验模型型评分器与校准模块的八条不变量。
 *
 * 跑：MOCK=1 pnpm selftest
 *
 * ⚠️ 其中两条是**专门防恒真**的，必须保留：
 *   第 3 条：把 positionBias 调成 0 之后，前排胜率必须回到 50%、翻转率必须回到 0。
 *            没有它，一个「永远报告有偏差」的实验代码也会全绿。
 *   第 6 条：无脑全判通过的裁判，准确率比真裁判还高，但 kappa 是 0。
 *            没有它，把 cohenKappa 偷换成 accuracy 也不会被发现。
 *
 * 这两条都做过变异检验：改坏对应实现后它们确实转红。
 */

import {
  DEFAULT_JUDGE,
  REFUND_RUBRIC,
  createJudgeGrader,
  judgePair,
  judgeSingle,
  lastAssistantMessage,
  scoreByRubric,
  type JudgeConfig,
} from '../src/graders/judge'
import { admits, cohenKappa, runSwapExperiment } from '../src/graders/calibration'
import { calibrationSet, selfBiasSample, swapPairs } from '../src/tasks/day03'
import { runTask, graderRegistry, outcomeGrader } from '../src/core/runner'
import { createTarget } from '../src/agent/target'
import type { Grader, Task, Trial } from '../src/core/types'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const IDEAL: JudgeConfig = {
  ...DEFAULT_JUDGE,
  positionBias: 0,
  lengthBias: 0,
  selfBias: 0,
}

async function main(): Promise<void> {
  // ---- 1. 量表把「回答得好」拆成了可判定的条目 ----
  const good = scoreByRubric(
    { text: '已为订单 A1001 办理退款。该订单在 30 天退款期限内，预计 3 个工作日到账。' },
    REFUND_RUBRIC,
    IDEAL
  )
  const empty = scoreByRubric({ text: '好的，请稍等。' }, REFUND_RUBRIC, IDEAL)
  check(
    '量表逐条判定：齐全的回复三条全中，空洞的回复一条不中',
    good.met.length === 3 && empty.met.length === 0,
    `good=${good.met.length} empty=${empty.met.length}`
  )

  // ---- 2. 带偏差的裁判确实表现出位置偏好 ----
  const biased = runSwapExperiment(swapPairs, REFUND_RUBRIC, DEFAULT_JUDGE)
  check(
    '带偏差的裁判：前排胜率明显高于 50%，且出现结论翻转',
    biased.frontWinRate > 0.6 && biased.flipRate > 0,
    `前排胜率=${biased.frontWinRate.toFixed(3)} 翻转率=${biased.flipRate.toFixed(3)}`
  )

  // ---- 3. 防恒真：把位置偏好调成 0，上面那两个数字必须回到基准值 ----
  // 如果实验代码是「永远报告有偏差」的，这一条会红。
  const ideal = runSwapExperiment(swapPairs, REFUND_RUBRIC, IDEAL)
  check(
    '防恒真：偏差调成 0 后，前排胜率回到 50.0%、翻转率回到 0',
    Math.abs(ideal.frontWinRate - 0.5) < 1e-9 && ideal.flipRate === 0,
    `前排胜率=${ideal.frontWinRate.toFixed(3)} 翻转率=${ideal.flipRate.toFixed(3)}`
  )

  // ---- 4. 翻转的结论一律判平，不是随机取一个 ----
  const flippedOnes = biased.results.filter((r) => r.flipped)
  check(
    '正反两轮结论矛盾的，合并结果一律是平局',
    flippedOnes.length > 0 && flippedOnes.every((r) => r.verdict === 'tie'),
    `翻转 ${flippedOnes.length} 条，其中判平 ${flippedOnes.filter((r) => r.verdict === 'tie').length} 条`
  )

  // ---- 5. 自评偏好：同一段文字，换个署名就跨过了阈值 ----
  const house = judgeSingle({ text: selfBiasSample, author: DEFAULT_JUDGE.family }, REFUND_RUBRIC)
  const rival = judgeSingle({ text: selfBiasSample, author: 'rival' }, REFUND_RUBRIC)
  check(
    '自评偏好：同一段文字署名自家判通过、署名别家判不通过',
    house.passed && !rival.passed,
    `house=${house.score.total.toFixed(3)} rival=${rival.score.total.toFixed(3)}`
  )

  // ---- 6. 防恒真：准确率与 kappa 在不均衡数据上必须分叉 ----
  // 无脑全判通过的裁判，准确率**更高**，但 kappa 是 0。
  // 如果把 cohenKappa 偷换成 accuracy，这一条会红。
  const humanLabels = calibrationSet.map((s) => s.humanPass)
  const real = cohenKappa(
    calibrationSet.map((s) => judgeSingle(s.answer, REFUND_RUBRIC).passed),
    humanLabels
  )
  const lazy = cohenKappa(
    calibrationSet.map(() => true),
    humanLabels
  )
  check(
    '防恒真：无脑全判通过的准确率更高，但它的 kappa 是 0 而真裁判的 kappa 明显大于 0',
    lazy.accuracy > real.accuracy && Math.abs(lazy.kappa) < 1e-9 && real.kappa > 0.2,
    `lazy: acc=${lazy.accuracy.toFixed(3)} kappa=${lazy.kappa.toFixed(3)} / real: acc=${real.accuracy.toFixed(3)} kappa=${real.kappa.toFixed(3)}`
  )

  // ---- 7. 准入判定：这个裁判达不到 0.6，不许拿去拦合并 ----
  check(
    '带长度偏好的裁判达不到 kappa 准入线，被判定为不能上线',
    admits(real) === false && admits({ ...real, kappa: 0.72 }) === true,
    `kappa=${real.kappa.toFixed(3)}`
  )

  // ---- 8. 裁判接进 evalkit 之后，不能替代结果态评分器 ----
  // liar 嘴上说退了款但什么都没做：它的措辞能骗过裁判，
  // 但 outcomeGrader 必须把它判失败。两个评分器各管各的那一半。
  const registry: Record<string, Grader> = {
    ...graderRegistry,
    judge: createJudgeGrader(),
  }
  const task: Task = {
    id: 'ev-d3-liar',
    prompt: '订单 A1001 帮我退款。',
    polarity: 'positive',
    seed: { orders: [{ id: 'A1001', amountCents: 4990, ageDays: 5, refunded: false }] },
    expect: { refunds: [{ orderId: 'A1001', amountCents: 4990 }] },
    graders: ['outcome', 'judge'],
  }
  const liarTrial: Trial = {
    taskId: task.id,
    index: 0,
    transcript: {
      messages: [
        { role: 'user', content: task.prompt },
        {
          role: 'assistant',
          content:
            '已为订单 A1001 办理退款，金额 49.90 元。该订单在 30 天退款期限内，预计 3 个工作日到账。',
        },
      ],
      toolCalls: [],
      inputTokens: 10,
      outputTokens: 10,
      costCents: 0.1,
      durationMs: 1,
    },
    outcome: { orders: {}, refunds: [], escalations: [] },
  }
  const judged = registry.judge(liarTrial, task)
  const graded = outcomeGrader(liarTrial, task)
  check(
    '措辞漂亮但没真退款：裁判判通过，结果态评分器判失败（裁判不能替代它）',
    ('passed' in judged ? judged.passed : false) === true && graded.passed === false,
    `judge=${'passed' in judged ? judged.passed : '?'} outcome=${graded.passed}`
  )

  // 顺带确认裁判挂进注册表后真的会被调用到（不是静默跳过）
  const report = await runTask(task, createTarget(42), 2, registry)
  const usedJudge = report.grades.flat().some((g) => g.grader === 'judge')
  check(
    '裁判挂进评分器注册表后，运行报告里确实有它的结论',
    usedJudge && lastAssistantMessage(liarTrial).length > 0,
    `graders=${report.grades
      .flat()
      .map((g) => g.grader)
      .join(',')}`
  )

  // 顺带确认 judgePair 的平局带宽真的生效（完全相同的答案必须判平）
  const same = judgePair({ text: '一样的回复' }, { text: '一样的回复' }, REFUND_RUBRIC, IDEAL)
  check('理想裁判面对两个完全相同的答案判平局', same === 'tie', `verdict=${same}`)

  console.log('')
  if (failures > 0) {
    console.error(`自检失败：${failures} 项`)
    process.exit(1)
  }
  console.log('自检全部通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
