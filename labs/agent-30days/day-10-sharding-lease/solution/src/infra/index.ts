// 基础设施的端口与内存实现。业务代码（lease.ts / worker.ts）只认这里的接口：
// MOCK=1 走内存实现，设置 REDIS_URL 走真实 Redis，两条路是同一份业务代码。

export type InboundMessage = { userId: string; seq: number; text: string }
export type Delivered = { id: string; msg: InboundMessage }
export type Infra = { kind: 'memory' | 'redis'; lease: LeaseStore; bus: Bus }

/**
 * 租约存储。刻意只暴露 Redis 真实存在的几条原语——选哪一条正是今天的练习：nextFence=INCR，
 * tryAcquire=SET NX PX，read=GET，pexpire=PEXPIRE（无条件，谁的都续），renewIfOwner=一段 Lua。
 */
export interface LeaseStore {
  nextFence(): Promise<number>
  tryAcquire(shard: number, value: string, ttlMs: number): Promise<boolean>
  read(shard: number): Promise<string | null>
  pexpire(shard: number, ttlMs: number): Promise<boolean>
  renewIfOwner(shard: number, value: string, ttlMs: number): Promise<boolean>
}

/** 每个 shard 一条子流。consume 先把闲置超过 reclaimIdleMs 的在途消息 claim 回来，再读新的。 */
export interface Bus {
  publish(shard: number, msg: InboundMessage): Promise<void>
  consume(shard: number, consumer: string, n: number, reclaimIdleMs: number): Promise<Delivered[]>
  ack(shard: number, ids: string[]): Promise<void>
  close(): Promise<void>
}

// 内存实现不是打桩：TTL 到期语义与 head-of-line 语义正是今天要教的东西，见 README。
type Entry = { id: string; msg: InboundMessage; holder: string | null; at: number; acked: boolean }
type Lease = { value: string; expiresAt: number }

export class MemoryLeaseStore implements LeaseStore {
  private readonly keys = new Map<number, Lease>()
  private fence = 0

  /** Redis 的过期是「到点不一定立刻删，读到它时才发现它已经没了」，这就是那个语义。 */
  private live(shard: number): Lease | undefined {
    const e = this.keys.get(shard)
    if (e && e.expiresAt <= Date.now()) this.keys.delete(shard)
    return this.keys.get(shard)
  }
  async nextFence(): Promise<number> {
    return (this.fence += 1)
  }
  async tryAcquire(shard: number, value: string, ttlMs: number): Promise<boolean> {
    if (this.live(shard)) return false
    this.keys.set(shard, { value, expiresAt: Date.now() + ttlMs })
    return true
  }
  async read(shard: number): Promise<string | null> {
    return this.live(shard)?.value ?? null
  }
  async pexpire(shard: number, ttlMs: number): Promise<boolean> {
    const e = this.live(shard)
    if (e) e.expiresAt = Date.now() + ttlMs
    return e !== undefined
  }
  async renewIfOwner(shard: number, value: string, ttlMs: number): Promise<boolean> {
    // 这三行之间没有 await，在 JS 单线程里是一次不可打断的执行——天然原子。
    // Redis 那边要靠 EVAL 把两条命令粘成一条才有同样的保证，这就是 Lua 存在的理由。
    const e = this.live(shard)
    if (!e || e.value !== value) return false
    e.expiresAt = Date.now() + ttlMs
    return true
  }
}

export class MemoryBus implements Bus {
  private readonly streams = new Map<number, Entry[]>()
  private nextId = 0

  private stream(shard: number): Entry[] {
    const s = this.streams.get(shard) ?? []
    this.streams.set(shard, s)
    return s
  }
  async publish(shard: number, msg: InboundMessage): Promise<void> {
    this.nextId += 1
    this.stream(shard).push({
      id: `${shard}-${this.nextId}`,
      msg,
      holder: null,
      at: 0,
      acked: false,
    })
  }
  async consume(shard: number, consumer: string, n: number, reclaimIdleMs: number) {
    const out: Delivered[] = []
    const now = Date.now()
    for (const e of this.stream(shard)) {
      if (e.acked) continue
      if (out.length >= n) break
      // 关键的一行：遇到「还捏在别人手里、闲置还不够久」的消息就停下，不跳过它去拿后面的。
      // 同一个用户的顺序就靠这条 head-of-line 规则。
      if (e.holder !== null && e.holder !== consumer && now - e.at < reclaimIdleMs) break
      e.holder = consumer
      e.at = now
      out.push({ id: e.id, msg: e.msg })
    }
    return out
  }
  async ack(shard: number, ids: string[]): Promise<void> {
    for (const e of this.stream(shard)) if (ids.includes(e.id)) e.acked = true
  }
  async close(): Promise<void> {}
}

export async function createInfra(): Promise<Infra> {
  const url = process.env.REDIS_URL
  if (url && process.env.MOCK !== '1') {
    return (await import('./redis')).createRedisInfra(url)
  }
  return { kind: 'memory', lease: new MemoryLeaseStore(), bus: new MemoryBus() }
}
