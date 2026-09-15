/**
 * 一个**故意写坏**的评分器 —— 这一天最重要的教具。
 *
 * 它复现的是一个真实案例：某模型在一个公开基准上初评 42 分，
 * 排查后发现判分用了严格相等比较，「96.12」与「96.124991…」被判为不相等。
 * 判分修好之后，同一个模型同一套件得 95 分。
 * **53 个百分点的差距，全部来自评估本身的缺陷。**
 *
 * ⚠️ 这个文件是教具，不要照抄进生产。正确的写法在下面的 correctAmountGrader。
 */

import type { GradeResult, Task, Trial } from '../core/types'

/**
 * ❌ 坏的写法：把「分」换算成「元」之后做严格相等比较。
 *
 * 4990 分换成元是 49.9，看起来人畜无害。但只要中间经过一次
 * 除法与加法（比如先算小计再加税、或者按比例分摊），
 * 二进制浮点就会给出 49.900000000000006 这样的值，
 * 而 49.900000000000006 !== 49.9。
 *
 * 于是一个**完全正确**的退款被判成失败，而失败理由会写着
 * 「期望 49.9，实际 49.900000000000006」——
 * 一行看起来像是 Agent 算错了的日志。
 */
export function strictAmountGrader(trial: Trial, task: Task): GradeResult {
  const want = task.expect.refunds ?? []
  const got = trial.outcome.refunds

  for (const w of want) {
    const hit = got.find((g) => g.orderId === w.orderId)
    if (!hit) {
      return {
        passed: false,
        score: 0,
        reason: `缺少订单 ${w.orderId} 的退款`,
        grader: 'strict-amount',
      }
    }
    // ❌ 问题就在这三行：换算成元，再走一次会引入误差的运算，最后严格相等
    const wantYuan = w.amountCents / 100
    const gotYuan = (hit.amountCents / 100) * 3 - (hit.amountCents / 100) * 2
    if (gotYuan !== wantYuan) {
      return {
        passed: false,
        score: 0,
        reason: `金额不符：期望 ${wantYuan}，实际 ${gotYuan}`,
        grader: 'strict-amount',
      }
    }
  }
  return { passed: true, score: 1, reason: '金额一致', grader: 'strict-amount' }
}

/**
 * ✅ 正确的写法：**在整数域上比较**。
 *
 * 钱一律用最小单位（分）的整数表示，从头到尾不换算成浮点。
 * 这样根本不存在「差一点点」的问题，也就不需要容差。
 *
 * 如果某个量天生是浮点（比如耗时、相似度），那就显式给容差，
 * 并把容差写进任务定义而不是藏在评分器里——
 * 容差是业务判断，不是实现细节。
 */
export function correctAmountGrader(trial: Trial, task: Task): GradeResult {
  const want = task.expect.refunds ?? []
  const got = trial.outcome.refunds

  for (const w of want) {
    const hit = got.find((g) => g.orderId === w.orderId)
    if (!hit) {
      return {
        passed: false,
        score: 0,
        reason: `缺少订单 ${w.orderId} 的退款`,
        grader: 'correct-amount',
      }
    }
    if (hit.amountCents !== w.amountCents) {
      return {
        passed: false,
        score: 0,
        reason: `金额不符：期望 ${w.amountCents} 分，实际 ${hit.amountCents} 分`,
        grader: 'correct-amount',
      }
    }
  }
  return { passed: true, score: 1, reason: '金额一致', grader: 'correct-amount' }
}
