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
  const issues: SuiteIssue[] = []
  const push = (taskId: string, field: string, message: string): void => {
    issues.push({ taskId, field, message })
  }

  const seen = new Set<string>()

  for (const task of tasks) {
    const id = typeof task?.id === 'string' ? task.id : '(缺少 id)'

    if (!TASK_ID_PATTERN.test(id)) {
      push(id, 'id', `id 不符合格式 ${String(TASK_ID_PATTERN)}`)
    }
    if (seen.has(id)) {
      push(id, 'id', 'id 重复')
    }
    seen.add(id)

    if (typeof task?.prompt !== 'string' || task.prompt.trim() === '') {
      push(id, 'prompt', 'prompt 不能为空')
    }

    if (!isPolarity(task?.polarity)) {
      push(id, 'polarity', 'polarity 只能是 positive 或 negative')
    }

    // ---- seed ----
    const orders = task?.seed?.orders
    if (!Array.isArray(orders) || orders.length === 0) {
      push(id, 'seed.orders', 'seed.orders 至少要有一笔订单')
    } else {
      const orderIds = new Set<string>()
      for (const o of orders) {
        if (orderIds.has(o?.id)) push(id, 'seed.orders', `订单号 ${o?.id} 在同一个 seed 里重复`)
        orderIds.add(o?.id)
        if (!Number.isInteger(o?.amountCents) || o.amountCents <= 0) {
          push(id, 'seed.orders', `订单 ${o?.id} 的金额必须是正整数分`)
        }
        if (!Number.isInteger(o?.ageDays) || o.ageDays < 0) {
          push(id, 'seed.orders', `订单 ${o?.id} 的 ageDays 必须是非负整数`)
        }
      }

      // prompt 里提到的订单号必须真的在 seed 里。
      // 漏了这条，任务会「永远通过」——Agent 查不到订单，什么也不做，
      // 而期望恰好也是什么都别做。一条永远通过的任务没有任何信息量。
      const mentioned = typeof task.prompt === 'string' ? task.prompt.match(/[A-Z]\d{4}/) : null
      if (mentioned && !orderIds.has(mentioned[0])) {
        push(id, 'prompt', `prompt 提到的订单 ${mentioned[0]} 不在 seed.orders 里`)
      }

      // 期望的退款必须指向 seed 里存在的订单，且金额一致。
      // 金额写错一分钱，这条任务会永远判失败，而失败原因看起来像是 Agent 的错。
      for (const r of task.expect?.refunds ?? []) {
        const hit = orders.find((o) => o?.id === r.orderId)
        if (!hit) {
          push(id, 'expect.refunds', `期望退款的订单 ${r.orderId} 不在 seed.orders 里`)
        } else if (hit.amountCents !== r.amountCents) {
          push(
            id,
            'expect.refunds',
            `期望退款金额 ${r.amountCents} 与订单 ${r.orderId} 的金额 ${hit.amountCents} 不符`
          )
        }
      }

      for (const e of task.expect?.escalations ?? []) {
        if (!orderIds.has(e)) {
          push(id, 'expect.escalations', `期望升级的订单 ${e} 不在 seed.orders 里`)
        }
      }
    }

    // ---- 极性与期望必须自洽 ----
    // 反向任务的定义就是「不该做时不能做」，它期望产生退款是自相矛盾的。
    const wantRefunds = task?.expect?.refunds ?? []
    if (task?.polarity === 'negative' && wantRefunds.length > 0) {
      push(id, 'expect.refunds', '反向任务不能期望产生退款')
    }
    if (task?.polarity === 'positive' && wantRefunds.length === 0) {
      push(id, 'expect.refunds', '正向任务必须至少期望一笔退款，否则它测不到「该做时做了」')
    }

    // ---- 评分器必须已注册 ----
    if (!Array.isArray(task?.graders) || task.graders.length === 0) {
      push(id, 'graders', 'graders 不能为空')
    } else {
      for (const g of task.graders) {
        if (!graderNames.includes(g)) push(id, 'graders', `评分器 ${g} 未注册`)
      }
    }

    // ---- 标签 ----
    if (!setTagOf(task)) {
      push(id, 'tags', `必须恰好带一个集合标签：${SET_TAGS.join(' 或 ')}`)
    }
    if (!pairKeyOf(task)) {
      push(id, 'tags', `必须恰好带一个 ${PAIR_PREFIX}xxx 配对标签`)
    }
  }

  // ---- 跨任务：双向覆盖 ----
  // 这是本模块存在的主要理由。只测正向的基准集会养出一个见谁都退款的 Agent，
  // 而这个缺陷在正向任务上是**看不见**的——它在那边反而加分。
  const pairs = new Map<string, Task[]>()
  for (const task of tasks) {
    const key = pairKeyOf(task)
    if (!key) continue
    const list = pairs.get(key) ?? []
    list.push(task)
    pairs.set(key, list)
  }
  for (const [key, list] of pairs) {
    const positives = list.filter((t) => t.polarity === 'positive').length
    const negatives = list.filter((t) => t.polarity === 'negative').length
    if (positives !== 1 || negatives !== 1) {
      push('suite', `pair:${key}`, `配对必须是一正一反，实际 ${positives} 正 ${negatives} 反`)
    }
    const sets = new Set(list.map((t) => setTagOf(t)))
    if (sets.size > 1) {
      push('suite', `pair:${key}`, '配对的两条任务必须在同一个集合里')
    }
  }

  return issues
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
  return {
    capability: tasks.filter((t) => setTagOf(t) === 'set:capability'),
    regression: tasks.filter((t) => setTagOf(t) === 'set:regression'),
  }
}
