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
        // 练习 2：投递即登记 pending。把 entry.id 记进 g.pending，
        // 值里带上是谁拿走的（consumer）、投递次数（首次投递就是 1）、投递时刻（Date.now()）。
        // 提示：这一步是 at-least-once 的全部底气。不登记的话，worker 崩在处理中途，
        // 这条消息就再也没人知道它存在过——自检第 4、5 项会一起变红。
        void consumer
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
      // 练习 3：遍历 g.pending，把「最后一次投递距今超过 minIdleMs」的那些改判给 consumer：
      // 改 entry.consumer、把 entry.deliveryCount 加 1、把 deliveredAt 刷成现在，
      // 然后从 state.entries 里取回这条消息的 fields 返回出去（最多 count 条）。
      // 提示：投递次数就是靠这一行长起来的，毒消息阈值读的正是它。
      // 参数与语义对不上时，去看 redis-bus.ts 里 XAUTOCLAIM 的那几个参数怎么传。
      // 挖空时的默认行为：谁都不接手 —— 崩掉的 worker 手上那条消息永远躺在 pending 里。
      void stream
      void group
      void consumer
      void minIdleMs
      void count
      const out: BusMessage[] = []
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
