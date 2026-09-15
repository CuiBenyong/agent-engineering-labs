// 基础设施的端口与内存实现。业务代码（worker.ts / gateway.ts / heartbeat.ts）只认这里的接口：
// MOCK=1 走内存实现，设置 REDIS_URL + DATABASE_URL 走真实 Redis 与 Postgres，
// 两条路跑的是同一份业务代码，差别只在这个目录里。
//
// 消费组语义来自 D9、租约的抢占与续约来自 D10、runs 表来自 D8，都原样沿用不改；
// 今天唯一新增的原语是 LeaseStore.releaseIfOwner——优雅停机时主动交还租约。

export interface BusMessage {
  id: string
  fields: Record<string, string>
}

export interface Bus {
  ensureGroup(stream: string, group: string): Promise<void>
  publish(stream: string, fields: Record<string, string>): Promise<string>
  readGroup(stream: string, group: string, consumer: string, count: number): Promise<BusMessage[]>
  ack(stream: string, group: string, ids: string[]): Promise<number>
  len(stream: string): Promise<number>
  close(): Promise<void>
}

export interface LeaseStore {
  tryAcquire(key: string, owner: string, ttlMs: number): Promise<boolean>
  renewIfOwner(key: string, owner: string, ttlMs: number): Promise<boolean>
  /** 今天新增：只删还写着我名字的那把牌子。无条件 DEL 会把别人的租约一起删掉。 */
  releaseIfOwner(key: string, owner: string): Promise<boolean>
  owner(key: string): Promise<string | null>
  close(): Promise<void>
}

export interface HeartbeatRow {
  workerId: string
  beatAt: number
  inFlight: number
  version: string
}

export interface PresenceStore {
  beat(key: string, row: HeartbeatRow): Promise<void>
  list(key: string): Promise<HeartbeatRow[]>
  forget(key: string, workerId: string): Promise<void>
  close(): Promise<void>
}

export type RunStatus = 'pending' | 'running' | 'done' | 'failed'

export interface RunRow {
  id: string
  sessionId: string
  userId: string
  idempotencyKey: string
  input: string
}

export interface RunStore {
  init(): Promise<void>
  /** 返回 false 表示撞了 idempotency_key 唯一约束（D8 定的那道闸门） */
  createRun(row: RunRow): Promise<boolean>
  setStatus(id: string, status: RunStatus): Promise<void>
  getRun(id: string): Promise<{ id: string; status: RunStatus } | null>
  ping(): Promise<void>
  close(): Promise<void>
}

export interface Infra {
  mode: 'memory' | 'real'
  bus: Bus
  lease: LeaseStore
  presence: PresenceStore
  store: RunStore
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// 内存实现：不是打桩，是把被教的语义用 Map 和数组写出来。
// ---------------------------------------------------------------------------

type Entry = { id: string; fields: Record<string, string>; holder: string | null; acked: boolean }

export class MemoryBus implements Bus {
  private readonly streams = new Map<string, Entry[]>()
  private nextId = 0

  private stream(name: string): Entry[] {
    const s = this.streams.get(name) ?? []
    this.streams.set(name, s)
    return s
  }
  async ensureGroup(stream: string): Promise<void> {
    this.stream(stream)
  }
  async publish(stream: string, fields: Record<string, string>): Promise<string> {
    this.nextId += 1
    const id = `${Date.now()}-${this.nextId}`
    this.stream(stream).push({ id, fields, holder: null, acked: false })
    return id
  }
  /** 消费组语义（D9）：一条消息只投递给组里的一个消费者，投出去就记进 pending */
  async readGroup(
    stream: string,
    _group: string,
    consumer: string,
    count: number
  ): Promise<BusMessage[]> {
    const out: BusMessage[] = []
    for (const e of this.stream(stream)) {
      if (out.length >= count) break
      if (e.acked || e.holder !== null) continue
      e.holder = consumer
      out.push({ id: e.id, fields: e.fields })
    }
    return out
  }
  async ack(stream: string, _group: string, ids: string[]): Promise<number> {
    let n = 0
    for (const e of this.stream(stream)) {
      if (ids.includes(e.id) && !e.acked) {
        e.acked = true
        n += 1
      }
    }
    return n
  }
  async len(stream: string): Promise<number> {
    return this.stream(stream).length
  }
  async close(): Promise<void> {}
}

type Lease = { value: string; expiresAt: number }

export class MemoryLeaseStore implements LeaseStore {
  private readonly keys = new Map<string, Lease>()

  /** Redis 的过期语义是「到点不一定立刻删，读到它时才发现它已经没了」（D10） */
  private live(key: string): Lease | undefined {
    const e = this.keys.get(key)
    if (e && e.expiresAt <= Date.now()) this.keys.delete(key)
    return this.keys.get(key)
  }
  async tryAcquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    if (this.live(key)) return false
    this.keys.set(key, { value: owner, expiresAt: Date.now() + ttlMs })
    return true
  }
  async renewIfOwner(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const e = this.live(key)
    if (!e || e.value !== owner) return false
    e.expiresAt = Date.now() + ttlMs
    return true
  }
  async releaseIfOwner(key: string, owner: string): Promise<boolean> {
    // 比较持有者和删除之间没有 await，在 JS 单线程里是一次不可打断的执行。
    // Redis 那边要用一段 Lua 才有同样的保证——和 D10 的续约脚本是同一个道理。
    const e = this.live(key)
    if (!e || e.value !== owner) return false
    this.keys.delete(key)
    return true
  }
  async owner(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null
  }
  async close(): Promise<void> {}
}

export class MemoryPresenceStore implements PresenceStore {
  private readonly tables = new Map<string, Map<string, HeartbeatRow>>()

  private table(key: string): Map<string, HeartbeatRow> {
    const t = this.tables.get(key) ?? new Map<string, HeartbeatRow>()
    this.tables.set(key, t)
    return t
  }
  async beat(key: string, row: HeartbeatRow): Promise<void> {
    this.table(key).set(row.workerId, row)
  }
  async list(key: string): Promise<HeartbeatRow[]> {
    return [...this.table(key).values()].sort((a, b) => a.workerId.localeCompare(b.workerId))
  }
  async forget(key: string, workerId: string): Promise<void> {
    this.table(key).delete(workerId)
  }
  async close(): Promise<void> {}
}

export class MemoryRunStore implements RunStore {
  private readonly rows = new Map<string, { row: RunRow; status: RunStatus }>()
  private readonly keys = new Set<string>()

  async init(): Promise<void> {}
  async createRun(row: RunRow): Promise<boolean> {
    // runs.idempotency_key 的唯一约束（D8）：撞上就当作重复提交，不再新建
    if (this.keys.has(row.idempotencyKey)) return false
    this.keys.add(row.idempotencyKey)
    this.rows.set(row.id, { row, status: 'pending' })
    return true
  }
  async setStatus(id: string, status: RunStatus): Promise<void> {
    const found = this.rows.get(id)
    if (found) found.status = status
  }
  async getRun(id: string): Promise<{ id: string; status: RunStatus } | null> {
    const found = this.rows.get(id)
    return found ? { id, status: found.status } : null
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

export async function createInfra(): Promise<Infra> {
  const redisUrl = process.env.REDIS_URL
  const databaseUrl = process.env.DATABASE_URL
  if (redisUrl && databaseUrl && process.env.MOCK !== '1') {
    return (await import('./real')).createRealInfra(redisUrl, databaseUrl)
  }
  const bus = new MemoryBus()
  const lease = new MemoryLeaseStore()
  const presence = new MemoryPresenceStore()
  const store = new MemoryRunStore()
  return {
    mode: 'memory',
    bus,
    lease,
    presence,
    store,
    close: async () => {},
  }
}
