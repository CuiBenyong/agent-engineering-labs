/**
 * 退化判定与三态门禁 —— 这一天最核心的工程判断都在这里。
 *
 * 要回答的问题只有一个：**这次分数下降，是退化还是抖动？**
 *
 * 单点比较（「比基线低就拦」）在一个每次跑分都会抖的系统上是灾难：
 * 它每周误报好几次，团队三周之内就会学会无脑重跑或者直接跳过门禁，
 * 于是这条门禁的实际拦截能力归零——**而它看起来还在那里，这是最糟的状态**。
 *
 * 所以判定按**区间**做，并且给三态而不是两态：
 *
 *   通过（pass）   下降在噪声范围内，放行，什么都不说
 *   警告（warn）   下降落在灰区，复跑之后仍在噪声内，放行但记一笔
 *   拦截（block）  下降超过噪声，或者出现了不可能是抖动的逐任务信号
 *
 * 两个阈值怎么定，见 DEFAULT_GATE 上面的注释——它们不是拍脑袋来的。
 */

import type { SuiteReport } from '../core/types'
import {
  compareFingerprint,
  toScores,
  type Baseline,
  type Fingerprint,
  type Scores,
} from './baseline'

export interface GateConfig {
  /** 下降不超过它 = 噪声，直接放行 */
  warnDrop: number
  /** 下降达到它 = 一定是退化，直接拦截 */
  blockDrop: number
  /** 灰区复跑时每个任务跑几次 */
  rerunK: number
}

/**
 * 默认阈值。**这两个数字来自实测，不是猜的。**
 *
 * 做法：固定任务集与 k，只换随机种子，把同一个 Agent 连跑 30 轮，
 * 看总体通过率的波动区间（本 lab 的 `pnpm start -- --noise` 会当场再算一遍）。
 *
 * 实测（全量档 8 条任务、k=5、30 个种子）：
 *   通过率区间 0.8500 – 0.9750，均值 0.9167，最大单轮偏离均值 0.0667
 *
 * 于是：
 *   warnDrop  = 0.12  —— 实测区间宽度是 0.1250，也就是「最幸运的一轮当基线、
 *                        最倒霉的一轮来对比」时能凭运气掉 12.5 个百分点。
 *                        阈值压在它略内侧：这种极端组合会落进灰区而不是直接拦截，
 *                        再由复跑把它收敛掉。**灰区存在的理由就是这一格。**
 *   blockDrop = 0.20  —— 是实测区间宽度的 1.6 倍，运气凑不出来
 *
 * ⚠️ 阈值是**你这套任务集和这个 k 的属性**，不是通用常数。
 *    换任务集、换 k、换模型，都要重新测一遍。照抄别人的阈值等于没定阈值。
 */
export const DEFAULT_GATE: GateConfig = {
  warnDrop: 0.12,
  blockDrop: 0.2,
  rerunK: 15,
}

/**
 * 冒烟档的阈值**必须单独测，而且宽得多**。
 *
 * 实测（冒烟档 3 条任务、k=5，也就是总共只有 15 次试次，30 个种子）：
 *   通过率区间 0.8000 – 1.0000，区间宽度 0.2000
 *   复跑档（k=20，共 60 次试次）：0.8167 – 0.9500
 *
 * 同一个 Agent、同一套判据，只因为试次少，噪声区间就从 12.5 个百分点涨到 20 个百分点。
 * 于是 warnDrop 必须放到 0.20，否则纯运气就能让门禁天天红。
 *
 * **这是分档的真实代价，必须说清楚**：冒烟档只能抓住 20 个百分点以上的事故，
 * 小幅退化它根本看不见——那是全量档的活。
 * 把冒烟档的绿色当成「没有退化」，是这套机制里最常见的自我安慰。
 */
export const SMOKE_GATE: GateConfig = {
  warnDrop: 0.2,
  blockDrop: 0.34,
  rerunK: 20,
}

export function gateFor(tier: 'smoke' | 'full'): GateConfig {
  return tier === 'smoke' ? SMOKE_GATE : DEFAULT_GATE
}

/** 判定的中间结论。gray 不是最终状态，它意味着「样本不够，再跑一次」。 */
export type Verdict = 'pass' | 'gray' | 'block'

/** 门禁对外的三态。 */
export type GateStatus = 'pass' | 'warn' | 'block'

export interface JudgeResult {
  verdict: Verdict
  /** 下降幅度（正数表示比基线低） */
  drop: number
  reasons: string[]
  /** 从「每次都过」掉到「每次都挂」的任务，它们不可能是抖动 */
  collapsedTasks: string[]
}

export interface GateInput {
  baseline: Baseline
  fingerprint: Fingerprint
  scores: Scores
}

/**
 * 纯函数判定：只看两份分数和一份配置，不跑任何东西。
 *
 * 拆成纯函数是为了能给它写便宜的测试——门禁本身出 bug 是最难发现的一类问题，
 * 因为它的失败形态是「永远放行」，而永远放行的门禁在所有绿色流水线上都表现正常。
 */
export function judge(input: GateInput, config: GateConfig = DEFAULT_GATE): JudgeResult {
  const reasons: string[] = []

  // ---- 第一道：指纹不一致就拒绝比较 ----
  const mismatched = compareFingerprint(input.baseline.fingerprint, input.fingerprint)
  if (mismatched.length > 0) {
    return {
      verdict: 'block',
      drop: 0,
      reasons: [
        `环境指纹不一致（${mismatched.join('、')}），这两次结果不可比。`,
        '要么换回原环境重跑，要么确认变更是有意的之后重新记录基线。',
      ],
      collapsedTasks: [],
    }
  }

  const drop = round4(input.baseline.scores.passRate - input.scores.passRate)

  // ---- 第二道：逐任务的「全绿变全红」----
  // 一条基线里 k 次全过的任务，现在 k 次全挂，这在噪声模型下是极小概率事件。
  // 总分可能因为别的任务变好而被抹平，所以这一条必须单独看。
  const collapsedTasks: string[] = []
  const byId = new Map(input.scores.tasks.map((t) => [t.taskId, t]))
  for (const base of input.baseline.scores.tasks) {
    const now = byId.get(base.taskId)
    if (!now) {
      reasons.push(`基线里的任务 ${base.taskId} 在本次运行里不见了。`)
      continue
    }
    if (base.passRate >= 1 && now.passRate <= 0) {
      collapsedTasks.push(base.taskId)
    }
  }
  if (collapsedTasks.length > 0) {
    reasons.push(`以下任务从每次都过变成每次都挂：${collapsedTasks.join('、')}。`)
    return { verdict: 'block', drop, reasons, collapsedTasks }
  }

  // ---- 第三道：总体通过率按区间比 ----
  if (drop >= config.blockDrop) {
    reasons.push(
      `总体通过率下降 ${pct(drop)}，超过拦截线 ${pct(config.blockDrop)}，已远离噪声区间。`
    )
    return { verdict: 'block', drop, reasons, collapsedTasks }
  }
  if (drop > config.warnDrop) {
    reasons.push(
      `总体通过率下降 ${pct(drop)}，落在灰区（${pct(config.warnDrop)} – ${pct(config.blockDrop)}），样本不足以下结论。`
    )
    return { verdict: 'gray', drop, reasons, collapsedTasks }
  }

  reasons.push(`总体通过率变化 ${pct(-drop)}，在噪声范围内。`)
  return { verdict: 'pass', drop, reasons, collapsedTasks }
}

export interface GateResult {
  status: GateStatus
  drop: number
  baselinePassRate: number
  currentPassRate: number
  reasons: string[]
  /** 是否触发过灰区复跑 */
  reran: boolean
  /** 复跑之后的下降幅度，没复跑时为 null */
  rerunDrop: number | null
  collapsedTasks: string[]
}

/**
 * 完整门禁：判定 + 灰区复跑。
 *
 * `rerun` 由调用方提供——门禁不该知道怎么跑评估，它只知道怎么下结论。
 * 这样这段逻辑能被纯粹地测试，也能接到任何一套执行器上。
 *
 * **只对灰区复跑**，不对所有失败复跑：
 * 无条件复跑等于把门禁的灵敏度乘以零，真退化也会被重跑掩盖掉。
 */
export async function runGate(
  input: GateInput,
  rerun: (k: number) => Promise<SuiteReport>,
  config: GateConfig = DEFAULT_GATE
): Promise<GateResult> {
  const first = judge(input, config)
  const base = {
    drop: first.drop,
    baselinePassRate: input.baseline.scores.passRate,
    currentPassRate: input.scores.passRate,
    collapsedTasks: first.collapsedTasks,
  }

  if (first.verdict === 'block') {
    return { ...base, status: 'block', reasons: first.reasons, reran: false, rerunDrop: null }
  }
  if (first.verdict === 'pass') {
    return { ...base, status: 'pass', reasons: first.reasons, reran: false, rerunDrop: null }
  }

  // ---- 灰区：加大样本再判一次 ----
  const second = toScores(await rerun(config.rerunK))
  const rerunDrop = round4(input.baseline.scores.passRate - second.passRate)
  const reasons = [...first.reasons]

  if (rerunDrop > config.warnDrop) {
    reasons.push(`以 ${config.rerunK} 次试次复跑后仍下降 ${pct(rerunDrop)}，不是抖动，拦截。`)
    return { ...base, status: 'block', reasons, reran: true, rerunDrop }
  }

  reasons.push(
    `以 ${config.rerunK} 次试次复跑后下降收敛到 ${pct(rerunDrop)}，判为抖动，放行但记一笔。`
  )
  return { ...base, status: 'warn', reasons, reran: true, rerunDrop }
}

/** 门禁状态到进程退出码。**拦截必须是非零**，否则它拦不住任何一次合并。 */
export function exitCodeFor(status: GateStatus): number {
  return status === 'block' ? 1 : 0
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)} 个百分点`
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}
