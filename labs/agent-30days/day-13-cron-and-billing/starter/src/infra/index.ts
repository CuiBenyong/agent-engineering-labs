/**
 * 基础设施的端口（port）+ 内存实现。业务代码只认 Bus / Store，走内存还是走真实的
 * Redis / Postgres 由环境变量决定（见文件末尾的 createInfra）。内存版不是打桩，是把当天
 * 要教的语义实现一遍：MemoryBus 复刻消费组（一条消息只发给组内一个消费者、ack 才销账，
 * 来自 D9），MemoryStore 复刻 runs.idempotency_key 唯一约束。这里一律用数组线性扫。
 */
export type BusMessage = { id: string; fields: Record<string, string> }

export interface Bus {
  ensureGroup(stream: string, group: string): Promise<void>
  publish(stream: string, fields: Record<string, string>): Promise<string>
  readGroup(stream: string, group: string, consumer: string, count: number): Promise<BusMessage[]>
  ack(stream: string, group: string, ids: string[]): Promise<number>
  close(): Promise<void>
}

/** runs 表的一行（字段来自 D8 定稿的 schema，本天不改）。 */
export type RunRow = { id: string; sessionId: string; userId: string; key: string; input: string }

/** usage_ledger 表的一行。costMicroUsd 是微美元整数，理由见 ledger.ts。 */
export type UsageRow = {
  id: string
  userId: string
  runId: string | null
  model: string
  kind: 'chat' | 'embedding'
  promptTokens: number
  completionTokens: number
  costMicroUsd: number
  createdAt: string
}

export interface Store {
  init(): Promise<void>
  /** 幂等落库：撞上 runs.idempotency_key 唯一约束就返回 false（= on conflict do nothing）。 */
  insertRun(row: RunRow): Promise<boolean>
  finishRun(id: string, promptTokens: number, completionTokens: number): Promise<void>
  insertUsage(row: UsageRow): Promise<void>
  allUsage(): Promise<UsageRow[]>
  close(): Promise<void>
}

export type Infra = { bus: Bus; store: Store; mode: 'memory' | 'real' }

type Entry = { id: string; fields: Record<string, string>; deliveredTo: string | null }

class MemoryBus implements Bus {
  private entries: Entry[] = []
  private groups = new Set<string>()
  private seq = 0
  async ensureGroup(stream: string, group: string): Promise<void> {
    this.groups.add(`${stream}/${group}`)
  }
  async publish(stream: string, fields: Record<string, string>): Promise<string> {
    const id = `${stream}-${this.seq++}`
    this.entries.push({ id, fields, deliveredTo: null })
    return id
  }
  async readGroup(stream: string, group: string, consumer: string, count: number) {
    if (!this.groups.has(`${stream}/${group}`)) return []
    const out: BusMessage[] = []
    for (const entry of this.entries) {
      if (out.length >= count) break
      // deliveredTo 非空 = 已经发给组内某个消费者，消费组不会把它重复发给第二个人
      if (entry.deliveredTo !== null) continue
      entry.deliveredTo = consumer
      out.push({ id: entry.id, fields: entry.fields })
    }
    return out
  }
  async ack(stream: string, group: string, ids: string[]): Promise<number> {
    const before = this.entries.length
    this.entries = this.entries.filter((entry) => !ids.includes(entry.id))
    return before - this.entries.length
  }
  async close(): Promise<void> {}
}

class MemoryStore implements Store {
  private keys = new Set<string>()
  private usage: UsageRow[] = []
  async init(): Promise<void> {}
  async insertRun(row: RunRow): Promise<boolean> {
    // 这个 Set 就是 runs.idempotency_key 的唯一约束：已存在就什么都不做并告诉调用方
    if (this.keys.has(row.key)) return false
    this.keys.add(row.key)
    return true
  }
  async finishRun(): Promise<void> {}
  async insertUsage(row: UsageRow): Promise<void> {
    this.usage.push(row)
  }
  async allUsage(): Promise<UsageRow[]> {
    return [...this.usage]
  }
  async close(): Promise<void> {}
}

export function createMemoryInfra(): Infra {
  return { bus: new MemoryBus(), store: new MemoryStore(), mode: 'memory' }
}

/** 唯一的选择点。动态 import 让 MOCK=1 的路径完全不加载 ioredis / pg。 */
export async function createInfra(): Promise<Infra> {
  const redisUrl = process.env.REDIS_URL
  const databaseUrl = process.env.DATABASE_URL
  if (!redisUrl || !databaseUrl) return createMemoryInfra()
  const { createRealInfra } = await import('./real')
  return createRealInfra(redisUrl, databaseUrl)
}
