/**
 * 模型型评分器（LLM-as-judge）—— D3 新增模块。
 *
 * 为什么要有它：结果态能查的东西，D1 的 outcomeGrader 已经查得又快又准。
 * 但「这句话对用户讲清楚了没有」查不了——退款记录表里没有这一列。
 * 开放式质量只能让另一个模型来判，这就是模型型评分器。
 *
 * ⚠️ 优先级不许颠倒：**能用代码判的绝不交给模型**。
 *    本文件的评分器只负责回复措辞这类开放式判据，
 *    退款有没有真的发生仍然由 outcomeGrader 判。
 *    一个任务上同时挂两个评分器，各管各的那一半。
 *
 * ## 为什么这里的裁判是离线的
 *
 * 真实裁判要调网关，而本课的重点是**把裁判本身考一遍**：
 * 位置偏好有多大、长度偏好有多大、和人工的一致性够不够。
 * 这三件事需要偏差**可控、可复现**——真实模型的偏差每次都在变，
 * 你没法拿它做对照实验（把偏差调成 0 再跑一遍）。
 *
 * 所以这里写了一个**带可配置偏差的离线裁判**：它真的会偏向排在前面的答案、
 * 真的会偏向更长的答案、真的会偏袒「自家」模型的输出。
 * 偏差系数是 JudgeConfig 里的三个数字，调成 0 就是一个理想裁判。
 * 这比接真模型更适合教学——**对照组是能跑出来的，不是想象出来的**。
 *
 * 接真实网关时只要把 scoreByRubric 换成一次 /v1/chat/completions 调用，
 * 本文件其余部分（量表结构、阈值、Grader 适配）原样可用。
 */

import type { GradeResult, Grader, Task, Trial } from '../core/types'

// ---------------------------------------------------------------------------
// 评分量表
// ---------------------------------------------------------------------------

/**
 * 量表里的一条判据。
 *
 * 三条纪律：
 *   1. **互不重叠**：两条判据不能因为同一个事实同时成立，否则它是在给同一件事记两次分。
 *   2. **可判定**：判据要能落到「文本里有没有这件事」，而不是「写得好不好」。
 *   3. **数量要少**：三到五条。条数一多，裁判的注意力被摊薄，分数反而更不稳。
 */
export interface Criterion {
  id: string
  name: string
  /** 给裁判看的说明。接真实模型时这段会原样进提示词。 */
  hint: string
  /** 离线裁判的判定依据：命中任意一个即视为满足。 */
  markers: string[]
}

/** 客服退款回复的量表：把模糊的「回答得好」拆成三条互不重叠的判据。 */
export const REFUND_RUBRIC: Criterion[] = [
  {
    id: 'outcome-stated',
    name: '说清最终处理结果',
    hint: '回复里必须明确说出这次到底退了、没退、还是转了人工，不能含糊带过。',
    markers: ['已为您办理退款', '已为订单', '无法退款', '不能退款', '已转人工', '已为您升级'],
  },
  {
    id: 'reason-given',
    name: '给出依据',
    hint: '回复里必须点明适用的退款政策与关键事实（例如下单距今多少天）。',
    markers: ['30 天', '退款期限', '退款政策'],
  },
  {
    id: 'next-step',
    name: '给出下一步',
    hint: '回复里必须告诉用户接下来会发生什么：到账时间、转人工路径或替代方案。',
    markers: ['工作日', '到账', '联系客服'],
  },
]

// ---------------------------------------------------------------------------
// 裁判配置：三种系统性偏差
// ---------------------------------------------------------------------------

/**
 * 裁判的三种系统性偏差，中文名全课统一（见连贯性卡片 §3.4）。
 *
 * 这三个系数是**教学用的旋钮**：调成 0 得到一个理想裁判，
 * 于是位置交换实验与一致性计算都有了对照组。
 * 真实模型上你调不了它们，只能测出来。
 */
export interface JudgeConfig {
  /** 位置偏好：成对比较时给排在前面那个答案的额外加分。 */
  positionBias: number
  /** 长度偏好：答案越长加分越多，封顶为这个值。 */
  lengthBias: number
  /** 自评偏好：答案出自裁判「自家」模型时的额外加分。 */
  selfBias: number
  /** 裁判自己的模型家族。答案的 author 与它相同时触发自评偏好。 */
  family: string
  /** 单条打分的通过线。 */
  passThreshold: number
  /** 成对比较的平局带宽：分差小于它就判平局。 */
  tieEpsilon: number
}

/**
 * 默认配置：**故意带偏差**，因为本课要量化的正是这些偏差。
 *
 * ⚠️ 这三个数字改成 0，自检的第 3、4 条会红——那两条是专门防恒真的。
 */
export const DEFAULT_JUDGE: JudgeConfig = {
  positionBias: 0.15,
  lengthBias: 0.25,
  selfBias: 0.1,
  family: 'house',
  passThreshold: 0.55,
  tieEpsilon: 0.05,
}

/** 一条待评的答案。author 用来触发自评偏好。 */
export interface Answer {
  text: string
  /** 出自哪个模型家族。与 JudgeConfig.family 相同时触发自评偏好。 */
  author?: string
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

export interface JudgeScore {
  /** 量表基础分：满足的判据数除以总条数。这一项是**无偏**的。 */
  base: number
  /** 长度偏好贡献了多少分。 */
  lengthBonus: number
  /** 自评偏好贡献了多少分。 */
  selfBonus: number
  /** 最终分，0..1。 */
  total: number
  /** 满足了哪几条判据。 */
  met: string[]
  /** 没满足哪几条。理由必须能列出来，只给一个数字是无法复核的。 */
  missed: string[]
}

/** 长度归一化：200 字以上一律算满。真实裁判没有这个上限，但有同方向的倾向。 */
const LENGTH_SATURATION = 200

/**
 * 按量表给一条答案打分。
 *
 * 分数 = 量表基础分 + 长度偏好 + 自评偏好，最后夹到 0..1。
 * **基础分是无偏的那一半，两个 bonus 是有偏的那一半**——
 * 把它们分开返回，是为了让校准报告能说清「这一分是从哪来的」。
 */
export function scoreByRubric(
  answer: Answer,
  rubric: Criterion[],
  cfg: JudgeConfig = DEFAULT_JUDGE
): JudgeScore {
  // TODO(练习 1)：按量表给一条答案打分。
  //
  // 要算四件事：
  //   a. 逐条判定：rubric 里每条判据的 markers 只要命中任意一个就算满足，
  //      满足的进 met，没满足的进 missed。**两个数组都要填**——
  //      missed 是校准报告里唯一能说清「差在哪」的东西。
  //   b. base = 满足的条数 / 判据总数。rubric 为空时返回 0，不要产出 NaN。
  //   c. lengthBonus = cfg.lengthBias × min(1, 文本长度 / LENGTH_SATURATION)
  //      这就是**长度偏好**：同样的内容，写得越长分越高。
  //   d. selfBonus = 答案的 author 与 cfg.family 相同时给 cfg.selfBias，否则 0
  //      这就是**自评偏好**：裁判偏袒自家模型的输出。
  //
  // total = base + lengthBonus + selfBonus，夹到 1 以内。
  //
  // ⚠️ 三项要分开返回，不要只返回一个 total。
  //    校准报告要能说清「这 0.58 分里有 0.25 是长度送的」，
  //    不然你没法判断该修量表还是该换裁判。
  void answer
  void cfg
  return {
    base: 0,
    lengthBonus: 0,
    selfBonus: 0,
    total: 0,
    met: [],
    missed: rubric.map((c) => c.id),
  }
}

/** 单条判定：分数过线就算通过。 */
export function judgeSingle(
  answer: Answer,
  rubric: Criterion[] = REFUND_RUBRIC,
  cfg: JudgeConfig = DEFAULT_JUDGE
): { passed: boolean; score: JudgeScore } {
  const score = scoreByRubric(answer, rubric, cfg)
  return { passed: score.total >= cfg.passThreshold, score }
}

// ---------------------------------------------------------------------------
// 成对比较
// ---------------------------------------------------------------------------

/** 成对比较的结论。tie 是一等公民，不是「没结论」的兜底。 */
export type PairVerdict = 'first' | 'second' | 'tie'

/**
 * 成对比较：把两个答案摆在裁判面前，问哪个更好。
 *
 * ⚠️ 位置偏好就在这里发生：**排在前面的那个拿到 positionBias 的额外加分**。
 *    真实模型上这件事是隐式的、你看不见的；这里把它写成一行代码，
 *    是为了让 D3 的位置交换实验有一个能被关掉的对照组。
 */
export function judgePair(
  first: Answer,
  second: Answer,
  rubric: Criterion[] = REFUND_RUBRIC,
  cfg: JudgeConfig = DEFAULT_JUDGE
): PairVerdict {
  const a = scoreByRubric(first, rubric, cfg).total + cfg.positionBias
  const b = scoreByRubric(second, rubric, cfg).total
  if (Math.abs(a - b) < cfg.tieEpsilon) return 'tie'
  return a > b ? 'first' : 'second'
}

// ---------------------------------------------------------------------------
// 接进 evalkit：把裁判包成一个 Grader
// ---------------------------------------------------------------------------

/** 取轨迹里最后一条 assistant 消息。裁判评的就是它。 */
export function lastAssistantMessage(trial: Trial): string {
  for (let i = trial.transcript.messages.length - 1; i >= 0; i -= 1) {
    const m = trial.transcript.messages[i]
    if (m.role === 'assistant') return m.content
  }
  return ''
}

/**
 * 把裁判包成 evalkit 的 Grader，就能和 outcomeGrader 挂在同一个任务上。
 *
 * ⚠️ 它**只判措辞**。退款有没有真的发生由 outcomeGrader 判——
 *    让裁判去读「已为您退款」并据此判通过，正是 D1 第 5 条断言要抓的错误。
 */
export function createJudgeGrader(
  rubric: Criterion[] = REFUND_RUBRIC,
  cfg: JudgeConfig = DEFAULT_JUDGE
): Grader {
  return function judgeGrader(trial: Trial, _task: Task): GradeResult {
    void _task
    const text = lastAssistantMessage(trial)
    if (text === '') {
      return { passed: false, score: 0, reason: '没有可评的回复', grader: 'judge' }
    }
    const { passed, score } = judgeSingle({ text }, rubric, cfg)
    const missedNames = score.missed
      .map((id) => rubric.find((c) => c.id === id)?.name ?? id)
      .join('、')
    return {
      passed,
      score: score.total,
      // 理由必须列出没满足的判据。只给一个 0.58 是没法复核的，
      // 而不可复核的裁判分数等于没有分数。
      reason: passed
        ? `量表得分 ${score.total.toFixed(2)}，满足 ${score.met.length}/${rubric.length} 条`
        : `量表得分 ${score.total.toFixed(2)}，缺：${missedNames || '（无）'}`,
      grader: 'judge',
    }
  }
}
