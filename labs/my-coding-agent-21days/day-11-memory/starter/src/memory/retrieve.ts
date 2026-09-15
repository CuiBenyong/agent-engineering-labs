/**
 * 检索：这一句话该带哪几条记忆进上下文。本天新增，是今天最难做对的一层。
 *
 * 一条纪律先立在前面：**默认是「不注入」，不是「全注入」。**
 * 一个记了三百条的目录全量注入等于把记忆变成了第二份系统提示，
 * 而其中两百九十条和这句话毫无关系——它们不只是浪费额度，还会把模型带偏。
 * 所以打分为零的记忆一条都不进，宁可漏也不要糊。
 *
 * 三个判据，按可靠性从高到低排（分数就是这个顺序）：
 *
 *   1. **路径命中**（+PATH_SCORE）。这句话里提到的文件，正好是某条记忆挂着的文件。
 *      这是最硬的信号：路径是个精确的东西，不会像词那样撞车。
 *   2. **关键词命中**（每个 +KEY_SCORE，最多算 KEY_HIT_CAP 个）。记忆的关键词出现在这句话里。
 *      撞一个词可能是巧合，撞三个基本就是同一个话题；**再多也不加分**——
 *      否则一条 keys 写得多的记忆会永远排在最前面。
 *   3. **来源加权**（显式那一路 +SOURCE_BONUS）。同分时，**用户亲手写下的压过模型自己沉淀的**。
 *      理由不是「人一定对」，是责任：用户写的那条他自己记得、能自己删；
 *      模型沉淀的那条谁都不知道它是哪一轮攒下来的。
 *
 * 最后按写入时间破平——同话题同来源，新的那条更可能是修正过的。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Memory } from './store.js'
import { SOURCE_LABEL } from './store.js'

export const PATH_SCORE = 3
export const KEY_SCORE = 2
export const SOURCE_BONUS = 1
/**
 * 关键词最多按几个计分。**这个上限不能省。**
 *
 * 少了它，一条关键词写得多的记忆会永远排在前面——它只要撞上七八个词就能压过
 * 一条路径精确命中的记忆。那不叫相关，那叫关键词堆砌，而堆砌它的既可能是
 * 兜底的抽词器，也可能是模型自己（它会很热心地给十二个 keys）。
 */
export const KEY_HIT_CAP = 3

/** 一次最多注入几条。**这个数字小得像是写错了，它就是要这么小** —— 理由见 inject.ts */
export const MEMORY_TOP_N = 3
/** 记忆这一路的字符预算。总预算怎么在各路之间分配是第十二天的题目 */
export const MEMORY_BUDGET_CHARS = 1_200
/** 没有锚点的记忆超过这个天数就提醒核对 */
export const MEMORY_AGING_DAYS = 30

/**
 * 一条记忆的核对结果。
 *
 * fresh   锚点核对通过，或者没有锚点但还年轻
 * aging   没有锚点、写下太久了：注入，但带一句「用之前先核对」
 * stale   有锚点而锚点失效了：**不注入**，只在终端列出来等用户处理
 */
export type MemoryStatus = 'fresh' | 'aging' | 'stale'

export interface CheckedMemory {
  memory: Memory
  status: MemoryStatus
  /** 为什么是这个状态，给人看 */
  note: string
  ageDays: number
}

/**
 * 用之前先核对。
 *
 * 这是今天最后一节的全部实现：**一条记忆的元信息里存着「靠什么判断它还成不成立」，
 * 注入之前去看一眼。** 锚点失效不等于这条记忆错了——也可能只是文件改了名——
 * 所以处理方式是「拿下来等人看」，而不是自动删。**自动删记忆是不可逆的，
 * 而判据只是一个 includes。**
 */
export async function check(
  memories: Memory[],
  cwd: string,
  now = Date.now()
): Promise<CheckedMemory[]> {
  // TODO(3)：用之前先核对。
  //
  // 一条记忆的元信息里存着「靠什么判断它还成不成立」（anchor），注入之前去看一眼：
  //   有锚点、文件读不到          → stale，note 说清是哪个文件不在了
  //   有锚点、文件里找不到那段字  → stale，note 说清是哪个文件里少了什么
  //   有锚点、核对通过            → fresh
  //   没有锚点、写下不到 MEMORY_AGING_DAYS 天  → fresh
  //   没有锚点、写下已经够久      → aging，note 里要出现「先核对」
  //
  // 两个判断值得先想清楚再写：
  //   ① 锚点失效**不等于**这条记忆错了（也可能只是文件改了名），所以处理方式是
  //      「拿下来等人看」而不是自动删。**自动删记忆是不可逆的，而判据只是一个 includes。**
  //   ② ageDays 要用 now 参数算，不要直接调 Date.now()——那样这个函数就没法被测。
  void cwd
  return memories.map((memory) => ({
    memory,
    status: 'fresh' as MemoryStatus,
    note: '还没有做核对',
    ageDays: Math.max(0, Math.floor((now - Date.parse(memory.at)) / 86_400_000)),
  }))
}

export interface Hit {
  memory: Memory
  status: MemoryStatus
  score: number
  /** 命中原因。**它必须打给用户看** —— 理由见 inject.ts */
  reasons: string[]
  ageDays: number
  /** 核对结果那句话，aging 与 stale 才有意义 */
  note: string
}

export interface Retrieval {
  hits: Hit[]
  /** 打了分但没进前 N 或者超预算的 */
  spilled: Hit[]
  /** 锚点失效、被拿下来等人处理的 */
  stale: Hit[]
  scanned: number
  chars: number
}

/**
 * 按一句话检索。query 通常是用户刚说的那句，也可以是「那句话 + 当前路径」拼起来的。
 */
export function retrieve(
  checked: CheckedMemory[],
  query: string,
  options: { limit?: number; budget?: number } = {}
): Retrieval {
  const limit = options.limit ?? MEMORY_TOP_N
  const budget = options.budget ?? MEMORY_BUDGET_CHARS
  const haystack = query.toLowerCase()

  const scored: Hit[] = []
  for (const entry of checked) {
    const reasons: string[] = []
    let score = 0

    // 判据一：路径。锚点路径也算——一条挂在某文件上的记忆，提到那个文件就该被想起来
    const paths = [
      ...new Set([
        ...entry.memory.paths,
        ...(entry.memory.anchor ? [entry.memory.anchor.path] : []),
      ]),
    ]
    const pathHits = paths.filter((p) => haystack.includes(p.toLowerCase()))
    if (pathHits.length > 0) {
      score += PATH_SCORE * pathHits.length
      reasons.push(`路径 ${pathHits.join('、')}`)
    }

    // 判据二：关键词。命中几个算几分
    const keyHits = entry.memory.keys.filter((key) => haystack.includes(key.toLowerCase()))
    if (keyHits.length > 0) {
      // TODO(4a)：这里少了一个上限。**KEY_HIT_CAP 那个上限不能省** ——
      // 少了它，一条 keys 写得多的记忆只要撞上七八个词就能压过一条路径精确命中的记忆。
      // 那不叫相关，那叫关键词堆砌，而堆砌它的既可能是兜底的抽词器，也可能是模型自己
      // （它会很热心地给十二个 keys）。命中原因那一行也要说清「等 N 个」，别只报前几个。
      score += KEY_SCORE * keyHits.length
      reasons.push(`关键词 ${keyHits.join('、')}`)
    }

    // TODO(4b)：一条都没命中的记忆，一条都不许进上下文。
    //
    // 默认是「不注入」而不是「全注入」：一个记了三百条的目录全量注入等于把记忆
    // 变成了第二份系统提示，而其中两百九十条和这句话毫无关系——它们不只是浪费额度，
    // 还会把模型带偏。**宁可漏也不要糊。** 这里只差一行。

    // 判据三：来源加权。同分时用户亲手写下的排前面
    if (entry.memory.source === 'command') {
      score += SOURCE_BONUS
      reasons.push(SOURCE_LABEL.command)
    }

    scored.push({
      memory: entry.memory,
      status: entry.status,
      score,
      reasons,
      ageDays: entry.ageDays,
      note: entry.note,
    })
  }

  scored.sort((a, b) => b.score - a.score || b.memory.at.localeCompare(a.memory.at))

  const stale = scored.filter((hit) => hit.status === 'stale')
  const usable = scored.filter((hit) => hit.status !== 'stale')

  const hits: Hit[] = []
  const spilled: Hit[] = []
  let chars = 0
  for (const hit of usable) {
    // 两条上限都要看：条数管「别糊」，字符管「别把额度吃光」
    if (hits.length >= limit || chars + hit.memory.text.length > budget) {
      spilled.push(hit)
      continue
    }
    hits.push(hit)
    chars += hit.memory.text.length
  }

  return { hits, spilled, stale, scanned: checked.length, chars }
}
