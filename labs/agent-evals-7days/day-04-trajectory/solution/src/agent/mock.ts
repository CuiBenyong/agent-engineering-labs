/**
 * 离线随机源 —— 让「非确定性」既真实又可复现。
 *
 * ⚠️ 冻结文件：D1 定稿，D2–D7 逐字复制，不许改。
 *    改动后必须跑 bash scripts/check-evals-consistency.sh。
 *    ⚠️ 新增剧本不许写进本文件，各天放独立的 script-*.ts
 *       （往冻结文件里加剧本会让前几天的副本立刻过期）。
 *
 * 这里刻意不用 Math.random()。理由是本课的核心矛盾：
 * 评估要面对非确定性，但评估**本身**必须可复现——
 * 不然你没法判断分数变了是因为改了代码，还是这次运气不好。
 *
 * mulberry32：32 位状态的小型 PRNG，同 seed 必然产出同一序列。
 * 它不适合密码学用途，但对「可复现的抖动」这个需求刚好够用。
 */

export type Rng = () => number

export function createRng(seed: number): Rng {
  // 取正整数状态；seed 可能是 Date.now() 这种大数，先压到 32 位
  let a = seed >>> 0
  return function rng(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
