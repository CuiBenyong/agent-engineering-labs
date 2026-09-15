/**
 * 倒数排名融合（reciprocal rank fusion，RRF）。
 *
 * 为什么不把两路的分数直接相加：BM25 的分是没有上界的对数和（本语料上 top-1 常在 8–23 之间），
 * 余弦相似度被钉死在 -1 到 1（mock 后端上相关块也就 0.2 出头）。
 * 两个量纲不可比，先各自除以本路最高分再加权也不稳——最高分是随查询浮动的，
 * 一条最不相干的结果只要碰巧是本路第一，归一化之后照样拿到满分 1.0。
 *
 * RRF 干脆不看分数，只看名次：**第几名就是第几名，这是两路唯一可比的东西。**
 *
 * 本文件是全课的融合口径（连贯性卡片 3.7ter），D10–D12 直接复用，不要各天各写一版。
 */

/** k = 60 是 RRF 原论文的常用取值，全课统一，不要各天各调一个 */
export const RRF_K = 60

/**
 * 每一路默认取前 50 条参与融合。
 *
 * 这个数字在生产里很保守（百万级语料里 50 条是万分之一），但在我们这份
 * 134 块的教学语料上，50 条等于把 **37% 的库**灌进了融合——
 * 相当于让两位侦探把半个城市的人都列成嫌疑人。`PER_ROUTE_K` 可以用环境变量覆盖，
 * 实验的第六段会跑一遍不同取值的对照，这是本天最容易被忽略的一个旋钮。
 */
export const PER_ROUTE_K = Number(process.env.PER_ROUTE_K ?? 50)
/** 融合后留前 20 条交给重排——不是全库重排，理由见正文的成本账 */
export const FUSE_KEEP = 20

export interface Fused {
  id: string
  score: number
}

/**
 * 输入是**每一路各自的有序 id 列表**（不是分数），不在列表里的文档不计分。
 *
 * k 是「压平器」：分母 k + 名次 越大，头几名之间的差距就越小。
 * k = 0 时第 1 名(1.0)是第 2 名(0.5)的两倍，一路的冠军几乎压得住另一路的所有结果；
 * k = 60 时第 1 名(0.0164)只比第 2 名(0.0161)高 1.6%，于是「两路都排进前列」
 * 反而比「一路排第一」更有分量——这正是我们要的：交叉验证过的结果优先。
 */
export function rrfFuse(rankings: string[][], k: number = RRF_K): Fused[] {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      // 名次从 1 起算
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)) // 同分按 id 排，保证可复现
}

/**
 * 换几个 k 值跑同一批排名，看前若干名变了多少。
 * 返回每个 k 对应的前 topN 列表，以及它与基准 k 的前 topN 有多少条不同。
 */
export function sweepRrfK(
  rankings: string[][],
  ks: number[],
  topN: number = 5,
  baseK: number = RRF_K
): Array<{ k: number; top: string[]; changedVsBase: number }> {
  const base = rrfFuse(rankings, baseK)
    .slice(0, topN)
    .map((f) => f.id)
  return ks.map((k) => {
    const top = rrfFuse(rankings, k)
      .slice(0, topN)
      .map((f) => f.id)
    // 逐位比：同一批 id 换了顺序也算变了，因为名次本身就是我们要看的东西
    const changedVsBase = top.filter((id, i) => id !== base[i]).length
    return { k, top, changedVsBase }
  })
}
