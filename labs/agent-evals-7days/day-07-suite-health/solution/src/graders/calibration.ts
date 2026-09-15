/**
 * 裁判的校准 —— D3 新增模块：位置交换实验 + Cohen's kappa。
 *
 * 本文件回答一个问题：**这个裁判能不能用？**
 *
 * 分两步：
 *   1. 位置交换实验：同一对答案正反各评一次，量出位置偏好有多大。
 *      判定规则是硬的——**只有两次都赢才算赢，翻转的一律判平**。
 *   2. 与人工标注比一致性：用 Cohen's kappa，**不是准确率**。
 *      准确率在标签不均衡时会系统性地骗人，理由见 cohenKappa 的注释。
 */

import { judgePair, type Answer, type Criterion, type JudgeConfig, type PairVerdict } from './judge'

// ---------------------------------------------------------------------------
// 位置交换实验
// ---------------------------------------------------------------------------

/** 一对待比较的答案。 */
export interface AnswerPair {
  id: string
  a: Answer
  b: Answer
  note?: string
}

/** 一对答案交换位置各评一次之后的结论。 */
export interface SwapResult {
  id: string
  /** 第一轮：a 在前。 */
  forward: PairVerdict
  /** 第二轮：b 在前。 */
  backward: PairVerdict
  /** 两轮合并后的最终结论：a 赢 / b 赢 / 平。 */
  verdict: 'a' | 'b' | 'tie'
  /** 两轮结论互相矛盾（翻转）。这类结论必须作废。 */
  flipped: boolean
}

export interface SwapReport {
  results: SwapResult[]
  /** 结论翻转的比例。这是位置偏好最直观的证据。 */
  flipRate: number
  /**
   * 在所有非平局的单轮判决里，赢家恰好排在前面的比例。
   * **没有位置偏好时它应该是 0.5**；显著高于 0.5 就是位置偏好。
   */
  frontWinRate: number
  /** 合并后仍然有效（非平局）的结论数。 */
  decisive: number
  /** 合并后判平的结论数。 */
  ties: number
}

/**
 * 位置交换实验：同一对答案正反各评一次。
 *
 * 合并规则（**全课固定，不许改**）：
 *   - 第一轮 a 赢、第二轮 a 也赢  → a 赢
 *   - 第一轮 b 赢、第二轮 b 也赢  → b 赢
 *   - 两轮结论不一致（翻转）      → **判平**，不是随机取一个
 *   - 任意一轮判平                → 判平
 *
 * 为什么翻转要判平而不是随机取一个：翻转说明这条结论**由位置而不是由质量决定**，
 * 它携带的信息量是零。随机取一个等于把噪声当成结论写进报告，
 * 而且那个噪声会以 50% 的概率碰巧和你的预期一致，让你更加相信它。
 */
export function runSwapExperiment(
  pairs: AnswerPair[],
  rubric: Criterion[],
  cfg: JudgeConfig
): SwapReport {
  const results: SwapResult[] = []
  let frontWins = 0
  let decisiveRounds = 0

  for (const p of pairs) {
    const forward = judgePair(p.a, p.b, rubric, cfg)
    const backward = judgePair(p.b, p.a, rubric, cfg)

    // 统计单轮层面的「前排胜率」：赢家是不是恰好被摆在前面
    for (const v of [forward, backward]) {
      if (v === 'tie') continue
      decisiveRounds += 1
      if (v === 'first') frontWins += 1
    }

    // 把两轮结论都翻译成「a 还是 b」，再看它们一不一致
    const firstRound: 'a' | 'b' | 'tie' =
      forward === 'tie' ? 'tie' : forward === 'first' ? 'a' : 'b'
    const secondRound: 'a' | 'b' | 'tie' =
      backward === 'tie' ? 'tie' : backward === 'first' ? 'b' : 'a'

    const flipped = firstRound !== 'tie' && secondRound !== 'tie' && firstRound !== secondRound
    const verdict: 'a' | 'b' | 'tie' = firstRound === secondRound ? firstRound : 'tie'

    results.push({ id: p.id, forward, backward, verdict, flipped })
  }

  const n = results.length
  const ties = results.filter((r) => r.verdict === 'tie').length
  return {
    results,
    flipRate: n === 0 ? 0 : results.filter((r) => r.flipped).length / n,
    // 没有任何非平局判决时返回 0.5（= 无偏），而不是 NaN
    frontWinRate: decisiveRounds === 0 ? 0.5 : frontWins / decisiveRounds,
    decisive: n - ties,
    ties,
  }
}

// ---------------------------------------------------------------------------
// 一致性：Cohen's kappa
// ---------------------------------------------------------------------------

export interface AgreementReport {
  n: number
  /** 观察一致率。也就是俗称的「准确率」。 */
  accuracy: number
  /** 随机也能达到的一致率。标签越不均衡，这个数越高。 */
  expected: number
  /** Cohen's kappa：把随机一致扣掉之后剩下的一致性。 */
  kappa: number
  /** 混淆矩阵，用来排查裁判是偏松还是偏严。 */
  matrix: { truePass: number; falsePass: number; trueFail: number; falseFail: number }
}

/**
 * Cohen's kappa：两个标注者在扣掉「瞎猜也能蒙对」的部分之后，还剩多少一致性。
 *
 *   po = 实际一致的比例（就是准确率）
 *   pe = 两人各自的标签分布下，随机也能一致的比例
 *   kappa = (po - pe) / (1 - pe)
 *
 * ## 为什么不用准确率（本天最反直觉的一点）
 *
 * 当标签极不均衡时——比如人工标注里 90% 都是「通过」——
 * **一个无脑全判通过的裁判，准确率也有 90%**。
 * 它一条信息都没有提供，但报告上那个 90% 看起来非常好。
 *
 * kappa 会把这种情况打回原形：此时 po = 0.9，pe 也 = 0.9，kappa = 0。
 * **kappa 为 0 的意思是「这个裁判等价于按标签分布瞎猜」**，与准确率多高无关。
 *
 * 经验阈值（Landis & Koch）：0.2 以下几乎没用，0.4–0.6 勉强，
 * 0.6–0.8 可以进流水线，0.8 以上很好。本课的准入线取 0.6。
 *
 * 分母 1 - pe 为 0 的退化情形（两人都把所有样本判成同一类）返回 0：
 * 那种情况下 kappa 在数学上没有定义，而「没有定义」在报告里必须表现为
 * 「这个裁判没提供信息」，绝不能表现为满分。
 */
export function cohenKappa(judge: boolean[], human: boolean[]): AgreementReport {
  const n = Math.min(judge.length, human.length)
  let truePass = 0
  let falsePass = 0
  let trueFail = 0
  let falseFail = 0
  for (let i = 0; i < n; i += 1) {
    if (judge[i] && human[i]) truePass += 1
    else if (judge[i] && !human[i]) falsePass += 1
    else if (!judge[i] && !human[i]) trueFail += 1
    else falseFail += 1
  }

  if (n === 0) {
    return {
      n: 0,
      accuracy: 0,
      expected: 0,
      kappa: 0,
      matrix: { truePass, falsePass, trueFail, falseFail },
    }
  }

  const po = (truePass + trueFail) / n
  const judgePassRate = (truePass + falsePass) / n
  const humanPassRate = (truePass + falseFail) / n
  const pe = judgePassRate * humanPassRate + (1 - judgePassRate) * (1 - humanPassRate)
  // pe 逼近 1 时 kappa 无定义。报 0 而不是报满分——见上面的注释。
  const kappa = 1 - pe < 1e-9 ? 0 : (po - pe) / (1 - pe)

  return {
    n,
    accuracy: po,
    expected: pe,
    kappa,
    matrix: { truePass, falsePass, trueFail, falseFail },
  }
}

/** 准入判定：kappa 过线才准拿这个裁判的分数去拦合并。 */
export const KAPPA_ADMISSION_THRESHOLD = 0.6

export function admits(report: AgreementReport): boolean {
  return report.kappa >= KAPPA_ADMISSION_THRESHOLD
}
