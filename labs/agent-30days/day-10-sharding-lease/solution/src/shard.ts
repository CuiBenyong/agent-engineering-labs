import { createHash } from 'node:crypto'

/** 固定 256 个分片，不是一致性哈希。改这个数等于一次数据迁移，所以一开始就定得偏大。 */
export const SHARD_COUNT = 256

/**
 * userId -> shard。唯一要求：同一个 userId 在任何进程、任何语言、任何一次重启之后都算出
 * 同一个 shard。摘要函数天生满足这一点，语言内置的字符串哈希不一定（CPython 加了随机盐）。
 */
export function shardOf(userId: string): number {
  return createHash('sha1').update(userId, 'utf8').digest().readUInt32BE(0) % SHARD_COUNT
}

/** 每个 worker 从不同位置开始扫，免得先启动的那个从 0 号格子把 shard 全揽下来。 */
export function scanOrder(workerId: string, count: number): number[] {
  const start = shardOf(workerId) % count
  return Array.from({ length: count }, (_, i) => (start + i) % count)
}
