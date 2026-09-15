/**
 * 基础设施的端口（port）+ 内存实现。业务代码只认 Store，走内存还是走真实 Postgres
 * 由 DATABASE_URL 决定（见文件末尾的 createStore）。
 *
 * 内存版不是打桩：external_events 的唯一约束是本天要教的东西，这里用一个 Set 把
 * 「已存在就什么都不做并告诉调用方」这条语义真实实现了一遍——和 D8 的 runs.idempotency_key 同一招。
 * 查询一律数组线性扫，真实版走索引。
 */
import type {
  ExternalEventRow,
  MemoryRow,
  MessageRow,
  UsageRow,
  UsageSummary,
} from '../shared/types'

export interface Store {
  init(): Promise<void>
  /** 只给自检用：把四张表清空，让同一条命令可以反复跑。 */
  reset(): Promise<void>
  /** 会话按用户取，没有就建（sessions 来自 D8）。 */
  ensureSession(userId: string): Promise<string>
  /**
   * 幂等插入。撞上 external_events.external_id 唯一约束就返回 false，
   * 对应 SQL 的 `on conflict (external_id) do nothing` 返回零行。
   */
  insertExternalEvent(externalId: string, kind: string, payload: string): Promise<boolean>
  countExternalEvents(): Promise<number>
  insertMessage(row: MessageRow): Promise<void>
  listMessages(sessionId: string): Promise<MessageRow[]>
  insertMemory(row: MemoryRow): Promise<void>
  listMemories(userId: string): Promise<MemoryRow[]>
  insertUsage(row: UsageRow): Promise<void>
  usageSummary(userId: string): Promise<UsageSummary>
  close(): Promise<void>
}

export type StoreHandle = { store: Store; mode: 'memory' | 'real' }

class MemoryStore implements Store {
  private sessions = new Map<string, string>()
  private externalIds = new Set<string>()
  private events: ExternalEventRow[] = []
  private messages: MessageRow[] = []
  private memories: MemoryRow[] = []
  private usage: UsageRow[] = []
  private seq = 0

  async init(): Promise<void> {}

  async reset(): Promise<void> {
    this.sessions.clear()
    this.externalIds.clear()
    this.events = []
    this.messages = []
    this.memories = []
    this.usage = []
  }

  async ensureSession(userId: string): Promise<string> {
    const existing = this.sessions.get(userId)
    if (existing) return existing
    const id = `s-${(this.seq += 1)}`
    this.sessions.set(userId, id)
    return id
  }

  async insertExternalEvent(externalId: string, kind: string, payload: string): Promise<boolean> {
    // 这个 Set 就是那条唯一约束：已经有了就什么都不做，并把「没插进去」如实告诉调用方
    if (this.externalIds.has(externalId)) return false
    this.externalIds.add(externalId)
    this.events.push({ externalId, kind, payload, createdAt: new Date().toISOString() })
    return true
  }

  async countExternalEvents(): Promise<number> {
    return this.events.length
  }

  async insertMessage(row: MessageRow): Promise<void> {
    this.messages.push(row)
  }

  async listMessages(sessionId: string): Promise<MessageRow[]> {
    return this.messages.filter((m) => m.sessionId === sessionId)
  }

  async insertMemory(row: MemoryRow): Promise<void> {
    this.memories.push(row)
  }

  async listMemories(userId: string): Promise<MemoryRow[]> {
    return this.memories.filter((m) => m.userId === userId)
  }

  async insertUsage(row: UsageRow): Promise<void> {
    this.usage.push(row)
  }

  async usageSummary(userId: string): Promise<UsageSummary> {
    const rows = this.usage.filter((r) => r.userId === userId)
    return {
      calls: rows.length,
      promptTokens: rows.reduce((n, r) => n + r.promptTokens, 0),
      completionTokens: rows.reduce((n, r) => n + r.completionTokens, 0),
      costMicroUsd: rows.reduce((n, r) => n + r.costMicroUsd, 0),
    }
  }

  async close(): Promise<void> {}
}

export function createMemoryStore(): StoreHandle {
  return { store: new MemoryStore(), mode: 'memory' }
}

/** 唯一的选择点。动态 import 让内存模式完全不加载 pg。 */
export async function createStore(): Promise<StoreHandle> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return createMemoryStore()
  const { createPgStore } = await import('./real')
  return createPgStore(databaseUrl)
}
