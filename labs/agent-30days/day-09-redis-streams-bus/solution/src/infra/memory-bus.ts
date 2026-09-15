import { sleep } from '../shared/config'
import type { Bus, BusMessage } from './bus'

type Entry = { id: string; fields: Record<string, string> }
/** PEL（pending entries list）里的一行：谁拿走的、投递过几次、最后一次投递在什么时候 */
type PendingEntry = { consumer: string; deliveryCount: number; deliveredAt: number }
/** 一个消费组的全部状态：读游标 + PEL */
type GroupState = { cursor: number; pending: Map<string, PendingEntry> }
type StreamState = { entries: Entry[]; groups: Map<string, GroupState> }

/**
 * Redis Streams 的内存实现。它**不是打桩**——不是「假装 XADD 成功了」，
 * 而是把 consumer group 的语义用一个数组加两个 Map 写出来：
 * entries 是流本身，cursor 是「这个组读到哪了」，pending 是「已投递但还没销号」的那张表。
 * 今天要教的东西全在这三个字段里。真 Redis 用 radix tree 存 entries、每个消费者一份 PEL；
 * 这里为了看清楚用线性扫描，保的是语义不是性能。
 */
export function createMemoryBus(): Bus {
  const streams = new Map<string, StreamState>()
  let counter = 0

  function streamOf(name: string): StreamState {
    const found = streams.get(name)
    if (found) return found
    const created: StreamState = { entries: [], groups: new Map() }
    streams.set(name, created)
    return created
  }

  function groupOf(stream: string, group: string): GroupState {
    const state = streamOf(stream)
    const found = state.groups.get(group)
    if (found) return found
    const created: GroupState = { cursor: 0, pending: new Map() }
    state.groups.set(group, created)
    return created
  }

  return {
    async ensureGroup(stream, group) {
      groupOf(stream, group)
    },

    async publish(stream, fields) {
      counter += 1
      const id = `${Date.now()}-${counter}`
      streamOf(stream).entries.push({ id, fields: { ...fields } })
      return id
    },

    async readGroup(stream, group, consumer, count, blockMs) {
      const state = streamOf(stream)
      const g = groupOf(stream, group)
      const out: BusMessage[] = []
      // 游标只往前走，同一条消息不会被同组的第二个 worker 再拿到一次——「分摊」就是这一行
      while (g.cursor < state.entries.length && out.length < count) {
        const entry = state.entries[g.cursor]
        g.cursor += 1
        // 投递即登记 pending：这一步是 at-least-once 的全部底气。不登记的话，
        // worker 崩在处理中途，这条消息就再也没人知道它存在过
        g.pending.set(entry.id, { consumer, deliveryCount: 1, deliveredAt: Date.now() })
        out.push({ id: entry.id, fields: entry.fields, deliveryCount: 1 })
      }
      // 真 Redis 的 BLOCK 是服务端挂住连接；内存版睡一小会儿，避免空转打满 CPU
      if (out.length === 0 && blockMs > 0) await sleep(Math.min(blockMs, 20))
      return out
    },

    async ack(stream, group, ids) {
      const g = groupOf(stream, group)
      let removed = 0
      for (const id of ids) if (g.pending.delete(id)) removed += 1
      // 返回「真的销掉了几条」。重复 XACK 同一条返回 0，这就是它天生幂等的原因
      return removed
    },

    async autoClaim(stream, group, consumer, minIdleMs, count) {
      const state = streamOf(stream)
      const g = groupOf(stream, group)
      const now = Date.now()
      const out: BusMessage[] = []
      for (const [id, entry] of g.pending) {
        if (out.length >= count) break
        if (now - entry.deliveredAt < minIdleMs) continue
        // 改判归属并把投递次数 +1。毒消息计数就是靠这一行长起来的
        entry.consumer = consumer
        entry.deliveryCount += 1
        entry.deliveredAt = now
        const found = state.entries.find((e) => e.id === id)
        if (found) out.push({ id, fields: found.fields, deliveryCount: entry.deliveryCount })
      }
      return out
    },

    async pendingCount(stream, group) {
      return groupOf(stream, group).pending.size
    },

    async length(stream) {
      return streamOf(stream).entries.length
    },

    async reset(names) {
      for (const n of names) streams.delete(n)
    },

    async close() {
      streams.clear()
    },
  }
}
