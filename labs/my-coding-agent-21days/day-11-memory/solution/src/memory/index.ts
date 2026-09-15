/**
 * 记忆这一路的对外入口：一句话进来，槽位刷新完、报账打完。本天新增。
 *
 * 把这四步（读盘 → 核对 → 检索 → 刷槽位）收在一个函数里，是因为它们的顺序不能变：
 * **核对必须在检索之前** —— 一条锚点失效的记忆不该参与排名，否则它会挤掉一条好记忆，
 * 然后自己又不注入，于是那一轮白丢了一条。
 *
 * 这个文件只放这一个函数与一张标签表；别的东西各回各家（store / retrieve / inject /
 * redact / tool），调用方直接从那几个文件 import。**不做一层「什么都往外转一遍」的门面** ——
 * 那种文件唯一的作用是让你多一处要同步的清单。
 */
import { REPO_DIR } from '../seed.js'
import type { Message } from '../kernel/types.js'
import { load, type Memory } from './store.js'
import { check, retrieve, type MemoryStatus, type Retrieval } from './retrieve.js'
import {
  buildMemoryMessage,
  formatMemoryReport,
  refreshMemorySlot,
  slotCost,
  type SlotAction,
} from './inject.js'

export const STATUS_LABEL: Record<MemoryStatus, string> = {
  fresh: '有效',
  aging: '待核对（旧）',
  stale: '待核对（锚点失效）',
}

export interface Refresh {
  retrieval: Retrieval
  action: SlotAction
  cost: { chars: number; tokens: number }
  report: string[]
}

/**
 * 按这一句话刷新记忆槽位。
 *
 * query 通常就是用户刚说的那句话。想更准可以把「他现在站在哪个目录」也拼进去——
 * **路径判据要的不只是他打出来的路径**：在 src/ 里干活时，挂在 src/calc.js 上的
 * 记忆本来就更该被想起来。
 */
export async function refreshMemory(
  messages: Message[],
  query: string,
  options: { cwd?: string; memories?: Memory[] } = {}
): Promise<Refresh> {
  const cwd = options.cwd ?? REPO_DIR
  const memories = options.memories ?? (await load())
  const checked = await check(memories, cwd)
  const retrieval = retrieve(checked, query)
  const action = refreshMemorySlot(messages, buildMemoryMessage(retrieval.hits))
  const cost = slotCost(messages)
  return { retrieval, action, cost, report: formatMemoryReport(retrieval, cost) }
}
