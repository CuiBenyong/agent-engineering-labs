/**
 * 基线快照 —— 把一次评估结果固化成可比较的文件。
 *
 * 这一天的第一条纪律：**快照里只记分数是没用的。**
 *
 * 下周分数从 82% 掉到 76%，如果快照里只有「82%」三个字，
 * 你没有任何办法回答「是谁动的」：是换了模型？改了提示词？加了两条任务？
 * 还是这次运气不好？四种可能里有三种根本不是退化。
 *
 * 所以快照分成两半：
 *   - **环境指纹**（fingerprint）：模型、提示词版本、任务集版本、evalkit 版本、试次数、档位。
 *     指纹不一致的两次结果**不可比**，门禁必须拒绝比较而不是硬算一个差值。
 *   - **分数**（scores）：总体通过率与逐任务通过率。
 *
 * 随机种子刻意**不**放进指纹，而是单独记一个字段。理由见 SEED_IS_NOT_FINGERPRINT。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SuiteReport } from '../core/types'

/**
 * 为什么种子记录但不参与指纹比对：
 *
 * 种子的用途是**复现一次具体的运行**——门禁红了，你要能一字不差地重跑那一次去排查。
 * 但它不是可比性的前提：换一个种子跑出来的分数，恰恰是我们用来估计噪声区间的样本。
 * 如果把种子塞进指纹，那么每次换种子都会被判成「不可比」，门禁就退化成了
 * 「只能在同一个种子上比」——那等于把非确定性从评估里删掉，也就删掉了这门课的全部前提。
 */
export const SEED_IS_NOT_FINGERPRINT = true

/** 环境指纹：这几项里任何一项变了，两次分数就不能直接相减。 */
export interface Fingerprint {
  /** 被评估的模型标识。离线模式下是 offline，真实网关下是 LLM_MODEL */
  model: string
  /** 提示词版本。提示词改一个字就要改它，否则分数变了查不出原因 */
  promptVersion: string
  /** 任务集版本，来自 tasks/day06.ts */
  taskSetVersion: string
  /** 评估框架自身的版本：评分器改了也会让分数变 */
  evalkitVersion: string
  /** 每个任务重复几次 */
  k: number
  /** 冒烟档还是全量档 */
  tier: 'smoke' | 'full'
}

/** 逐任务的分数。门禁除了看总分，还要看是哪几条掉的。 */
export interface TaskScore {
  taskId: string
  /** 该任务 k 次试次里通过的比例 */
  passRate: number
  passAtK: boolean
  passHatK: boolean
}

/** 分数部分。**刻意不含时间戳**：同一个种子跑两次，这一块必须逐字相同。 */
export interface Scores {
  /** 总体通过率 = 通过的试次数 / 总试次数 */
  passRate: number
  passAtKRate: number
  passHatKRate: number
  tasks: TaskScore[]
}

export interface Baseline {
  /** 快照格式版本，将来改结构时用它做迁移 */
  schema: 1
  fingerprint: Fingerprint
  /** 记录用于复现，不参与可比性判断 */
  seed: number
  /** 记录时间，只用于人看，不参与任何判断 */
  recordedAt: string
  scores: Scores
}

/** 把一次套件运行折算成三个总体比率与逐任务分数。 */
export function toScores(report: SuiteReport): Scores {
  // TODO 练习 1：把一次套件运行折算成分数。
  //
  //   passRate      = 通过的试次数 / 总试次数（所有任务加总，不是任务通过率的平均）
  //   passAtKRate   = report.passAtKRate
  //   passHatKRate  = report.passHatKRate
  //   tasks         = 逐任务的 { taskId, passRate, passAtK, passHatK }
  //
  // 两个容易踩的点：
  //   1. 全部数字过一遍 round4。不 round 的话浮点尾数会让「同种子两次快照逐字相同」
  //      这条断言变得极其脆弱——而那条断言是整套门禁的地基。
  //   2. 这里**不能**放时间戳或任何每次都变的东西，否则快照永远比不出相等。
  void report
  return { passRate: 0, passAtKRate: 0, passHatKRate: 0, tasks: [] }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

export function buildBaseline(
  report: SuiteReport,
  fingerprint: Fingerprint,
  seed: number,
  now: Date = new Date()
): Baseline {
  return {
    schema: 1,
    fingerprint,
    seed,
    recordedAt: now.toISOString(),
    scores: toScores(report),
  }
}

/**
 * 比对两个指纹，返回**不一致的字段名**。空数组表示可比。
 *
 * 门禁拿到非空数组时必须拒绝比较——硬算一个差值再判通过/拦截，
 * 是这套机制里最容易犯、也最贵的错：你会拿换了模型之后的分数去和旧基线比，
 * 得出一个毫无意义的结论，而且它看起来很正常。
 */
export function compareFingerprint(a: Fingerprint, b: Fingerprint): string[] {
  // TODO 练习 2：逐字段比对两个指纹，返回**不一致的字段名数组**，全一致时返回空数组。
  // 六个字段：model / promptVersion / taskSetVersion / evalkitVersion / k / tier。
  //
  // 返回空数组（也就是「永远可比」）是这道题最危险的错误答案：
  // 它会让你拿换了模型之后的分数去和旧基线比，得出一个毫无意义但看起来很正常的结论。
  void a
  void b
  return []
}

export function writeBaseline(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
}

/** 读不到就返回 null——「还没有基线」是一个正常状态，不是异常。 */
export function readBaseline(path: string): Baseline | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isBaseline(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function isBaseline(v: unknown): v is Baseline {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return o.schema === 1 && typeof o.fingerprint === 'object' && typeof o.scores === 'object'
}
