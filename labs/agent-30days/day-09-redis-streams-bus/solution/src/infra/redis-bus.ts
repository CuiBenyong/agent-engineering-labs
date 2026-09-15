import Redis from 'ioredis'

import type { Bus, BusMessage } from './bus'

// 回包是嵌套数组，逐层收窄，不用 any
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asString = (v: unknown): string => (typeof v === 'string' ? v : String(v))

/** Redis 的字段是扁平的 [k, v, k, v]，还原成对象 */
function toFields(v: unknown): Record<string, string> {
  const flat = asArray(v).map(asString)
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1]
  return out
}

function toEntries(v: unknown): { id: string; fields: Record<string, string> }[] {
  return asArray(v).flatMap((row) => {
    const pair = asArray(row)
    if (pair.length < 2 || pair[1] === null) return []
    return [{ id: asString(pair[0]), fields: toFields(pair[1]) }]
  })
}

/**
 * 真实实现。刻意用 redis.call 直接发原生命令：你在 redis-cli 里敲的就是这几行，
 * 换成任何语言的客户端也是同样的命令序列，所以这份代码同时是一份命令参考。
 */
export function createRedisBus(url: string): Bus {
  const redis = new Redis(url, { maxRetriesPerRequest: 3 })

  /** XPENDING 明细形式返回 [id, consumer, idleMs, deliveryCount]，只取最后一列 */
  async function deliveryCounts(stream: string, group: string): Promise<Map<string, number>> {
    const rows = asArray(await redis.call('XPENDING', stream, group, '-', '+', '100'))
    const map = new Map<string, number>()
    for (const row of rows) {
      const cols = asArray(row)
      map.set(asString(cols[0]), Number(cols[3] ?? 1))
    }
    return map
  }

  return {
    async ensureGroup(stream, group) {
      try {
        // MKSTREAM：流还不存在时顺手建出来，否则会报 ERR no such key
        await redis.call('XGROUP', ['CREATE', stream, group, '0', 'MKSTREAM'])
      } catch (err) {
        // 组已存在是正常情况（每个 worker 启动都会调一次），只有它能被吞掉
        if (!String(err).includes('BUSYGROUP')) throw err
      }
    },

    async publish(stream, fields) {
      return asString(await redis.call('XADD', [stream, '*', ...Object.entries(fields).flat()]))
    },

    async readGroup(stream, group, consumer, count, blockMs) {
      // 结尾那个大于号是关键：只要「从没投递给本组任何人」的消息。
      // 换成 0 就变成「重读我自己 pending 里的那些」，是另一回事
      const args = [
        'GROUP',
        group,
        consumer,
        'COUNT',
        count,
        'BLOCK',
        blockMs,
        'STREAMS',
        stream,
        '>',
      ]
      const raw = await redis.call('XREADGROUP', args)
      // XREADGROUP 拿到的一定是首次投递，投递次数就是 1
      return toEntries(asArray(asArray(raw)[0])[1]).map((e) => ({ ...e, deliveryCount: 1 }))
    },

    async ack(stream, group, ids) {
      if (ids.length === 0) return 0
      return Number(await redis.call('XACK', [stream, group, ...ids]))
    },

    async autoClaim(stream, group, consumer, minIdleMs, count) {
      // 返回 [下一轮游标, 被改判的消息, 已被删除的 id]
      const args = [stream, group, consumer, minIdleMs, '0', 'COUNT', count]
      const raw = asArray(await redis.call('XAUTOCLAIM', args))
      const entries = toEntries(raw[1])
      if (entries.length === 0) return []
      // XAUTOCLAIM 的回包不带投递次数，补一次 XPENDING 去读（此刻已被它加过 1）
      const counts = await deliveryCounts(stream, group)
      return entries.map<BusMessage>((e) => ({ ...e, deliveryCount: counts.get(e.id) ?? 1 }))
    },

    async pendingCount(stream, group) {
      return Number(asArray(await redis.call('XPENDING', [stream, group]))[0] ?? 0)
    },

    async length(stream) {
      return Number(await redis.call('XLEN', stream))
    },

    async reset(names) {
      if (names.length > 0) await redis.call('DEL', names)
    },

    async close() {
      await redis.quit()
    },
  }
}
