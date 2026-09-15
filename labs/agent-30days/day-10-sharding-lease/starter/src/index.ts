import 'dotenv/config'

import { createInfra } from './infra/index'
import { runSelfTest } from './selftest'
import { SHARD_COUNT } from './shard'
import { MessageStore, ShardWorker } from './worker'

export interface Config {
  leaseTtlMs: number
  renewIntervalMs: number
  tickMs: number
  acquireBatch: number
  readBatch: number
  reclaimIdleMs: number
}

/** 全周固定口径：租约 TTL 30 秒，续约间隔 10 秒（TTL 的三分之一，容得下连续两次失败）。 */
export const PRODUCTION_CONFIG: Config = {
  leaseTtlMs: 30_000,
  renewIntervalMs: 10_000,
  tickMs: 1_000,
  acquireBatch: 32,
  readBatch: 8,
  reclaimIdleMs: 30_000,
}

/** 自检把整个时钟等比压缩 10 倍，否则跑一遍要两分多钟；比例关系与生产值一致。 */
export const SELFTEST_CONFIG: Config = {
  ...PRODUCTION_CONFIG,
  leaseTtlMs: 3_000,
  renewIntervalMs: 1_000,
  tickMs: 200,
  acquireBatch: 64,
  reclaimIdleMs: 1_500,
}

async function runWorker(): Promise<void> {
  const infra = await createInfra()
  const id = process.env.WORKER_ID ?? 'worker-1'
  const log = (m: string): void => console.log(`[${id}] ${m}`)
  const worker = new ShardWorker(id, infra, new MessageStore(), PRODUCTION_CONFIG, log)
  worker.start()
  log(`已启动：基础设施=${infra.kind}，TTL=30000ms，续约=10000ms`)
  // 内存实现是进程内的：两个终端各有一份内存，看不到彼此的租约，手动复现必须先起 Redis。
  if (infra.kind === 'memory') log('双终端复现请先 docker compose up -d 并设置 REDIS_URL')
  setInterval(() => log(`持有 ${worker.lease.held.size} / ${SHARD_COUNT} 个 shard`), 5_000)
  // Ctrl+C 直接退出，不主动交还租约——让另一个 worker 走一遍 TTL 到期后的 handoff。
  // 优雅停机（退出前先 release、等手头任务跑完）是 D14 的内容。
  process.on('SIGINT', () => process.exit(0))
}

async function main(): Promise<void> {
  if (process.env.SELFTEST === '1') process.exit((await runSelfTest(SELFTEST_CONFIG)) ? 0 : 1)
  return runWorker()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
