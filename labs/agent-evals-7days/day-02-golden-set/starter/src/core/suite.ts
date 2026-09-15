/**
 * 基准集的加载与校验 —— D2 新增模块。
 *
 * 一条贯穿的设计决定：**基准集是数据文件，不是代码**。
 * 它存成 JSON，能被非工程师 review，能进 git diff，能在 CI 里被 D6 的门禁读取。
 * 代价是它没有类型检查兜底，所以必须有一个校验器把「手写 JSON 会犯的错」全部挡在门外。
 *
 * 校验器要挡的不是语法错误（JSON.parse 会报），而是**语义上写错但跑得起来**的那些：
 * 期望的金额和订单对不上、反向任务却期望产生退款、配对的两条被分进了不同的集合。
 * 这类错误不会让程序崩，只会让分数变得毫无意义。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import type { Polarity, Task } from './types'

/** 集合标签：每条任务必须恰好带一个。 */
export const SET_TAGS = ['set:capability', 'set:regression'] as const
export type SetTag = (typeof SET_TAGS)[number]

/** 配对标签前缀：正反两条任务靠它认亲。 */
export const PAIR_PREFIX = 'pair:'

/** 任务 id 的格式。有格式就能排序、能在报告里对齐、能一眼看出是哪一批。 */
export const TASK_ID_PATTERN = /^ev-\d{3}-[a-z0-9-]+$/

export interface SuiteIssue {
  /** 出问题的任务 id；跨任务的问题（比如配对不全）填 'suite' */
  taskId: string
  field: string
  message: string
}

export interface GoldenFile {
  version: string
  note?: string
  tasks: Task[]
}

/** 默认基准集路径：src/tasks/golden.json。 */
export function defaultGoldenPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../tasks/golden.json')
}

/**
 * 从磁盘读基准集。
 *
 * 刻意用 fs 读而不是 import JSON：基准集在 D6 会由 CI 从别处传进来，
 * 路径是运行期决定的。顺便也避免了 tsconfig 的 resolveJsonModule 依赖。
 */
export function loadGoldenSet(file: string = defaultGoldenPath()): GoldenFile {
  const raw = readFileSync(file, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`基准集不是一个对象：${file}`)
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.tasks)) {
    throw new Error(`基准集缺少 tasks 数组：${file}`)
  }
  return {
    version: typeof obj.version === 'string' ? obj.version : 'unknown',
    note: typeof obj.note === 'string' ? obj.note : undefined,
    tasks: obj.tasks as Task[],
  }
}

function isPolarity(v: unknown): v is Polarity {
  return v === 'positive' || v === 'negative'
}

/** 取任务的集合标签；没有或有多个都返回 undefined，由校验器报错。 */
export function setTagOf(task: Task): SetTag | undefined {
  const hit = (task.tags ?? []).filter((t): t is SetTag =>
    (SET_TAGS as readonly string[]).includes(t)
  )
  return hit.length === 1 ? hit[0] : undefined
}

/** 取任务的配对键；同理，必须恰好一个。 */
export function pairKeyOf(task: Task): string | undefined {
  const hit = (task.tags ?? []).filter((t) => t.startsWith(PAIR_PREFIX))
  return hit.length === 1 ? hit[0].slice(PAIR_PREFIX.length) : undefined
}

/**
 * 校验整份基准集。返回问题清单，空数组表示合格。
 *
 * 刻意返回清单而不是抛异常：一次把全部问题列出来，比修一条报一条快得多。
 */
export function validateSuite(tasks: Task[], graderNames: readonly string[]): SuiteIssue[] {
  // TODO(练习 1)：把下面这些规则实现出来，返回问题清单（空数组 = 合格）。
  //
  // 逐条任务要查的：
  //   a. id 符合 TASK_ID_PATTERN，且课程内不重复
  //   b. prompt 非空
  //   c. polarity 只能是 positive 或 negative
  //   d. seed.orders 至少一笔；金额是正整数分；ageDays 是非负整数；订单号不重复
  //   e. prompt 里提到的订单号必须真的在 seed.orders 里
  //      —— 漏了这条，任务会「永远通过」：Agent 查不到订单于是什么都不做，
  //         而期望恰好也是什么都别做。一条永远通过的任务没有任何信息量
  //   f. expect.refunds 指向的订单要存在，**且金额与订单金额一致**
  //      —— 金额写错一分钱，这条任务会永远判失败，而失败原因看起来像是 Agent 的错
  //   g. expect.escalations 指向的订单要存在
  //   h. 反向任务不能期望产生退款；正向任务必须至少期望一笔退款
  //   i. graders 非空，且每个名字都在 graderNames 里
  //   j. 必须恰好一个集合标签（用 setTagOf）和一个配对标签（用 pairKeyOf）
  //
  // 跨任务要查的（这是本模块存在的主要理由）：
  //   k. 每个 pair 恰好一正一反，且配对的两条在同一个集合里
  //
  // ⚠️ 返回清单而不是抛异常：一次把全部问题列出来，比修一条报一条快得多。
  //    每条 issue 的 field 要写准——scripts/selftest.ts 的第 3 条断言按字段核对。
  void tasks
  void graderNames
  return [{ taskId: 'suite', field: 'validateSuite', message: '未实现（练习 1）' }]
}

export interface SplitSuite {
  capability: Task[]
  regression: Task[]
}

/**
 * 按集合标签把基准集拆成两份。
 *
 * 能力集与回归集混在一个总分里，会让两种信号互相掩盖：
 * 总分掉两个点，你分不清是新能力没做上去（正常），还是老功能坏了（严重）。
 */
export function splitSuite(tasks: Task[]): SplitSuite {
  // TODO(练习 2)：按集合标签把基准集拆成能力集与回归集。
  //
  // 为什么要拆：两类分数混在一个总分里会互相掩盖——
  // 总分掉两个点，你分不清是新能力没做上去（正常），还是老功能坏了（严重）。
  void tasks
  return { capability: [], regression: [] }
}
