/**
 * 基础设施的端口（port）+ 内存实现。业务代码只认 Store，走内存还是走真实的
 * Redis / Postgres 由环境变量决定（见文件末尾的 createInfra）。内存版不是打桩，
 * 是把当天要教的语义实现一遍：计数器的原子自增与按用户本地日历日过期、
 * 延后队列的按到期时间取出。这里一律用 Map 和数组线性扫。
 */
export type DeferredItem = {
  id: string
  userId: string
  kind: string
  prompt: string
  expiresAt?: string
  dueAtMs: number
}

export type SendRow = {
  id: string
  userId: string
  channel: string
  idempotencyKey: string
  title: string
  body: string
  providerMessageId: string
  sentAtMs: number
}

export interface Store {
  init(): Promise<void>
  /** 原子自增并返回自增后的值。键里的日期是**用户本地日历日**，不是 UTC 日。 */
  bumpDaily(userId: string, localDate: string): Promise<number>
  /** 名额没用上就还回去：超限被拦、或者渠道明确拒绝时调用。 */
  releaseDaily(userId: string, localDate: string): Promise<void>
  dailyUsed(userId: string, localDate: string): Promise<number>
  pushDeferred(item: DeferredItem): Promise<void>
  /** 取出所有到期的延后项并从队列里移除。 */
  popDue(nowMs: number): Promise<DeferredItem[]>
  recordSend(row: SendRow): Promise<void>
  allSends(): Promise<SendRow[]>
  close(): Promise<void>
}

export type Infra = { store: Store; mode: 'memory' | 'real' }

class MemoryStore implements Store {
  private counters = new Map<string, number>()
  private deferred: DeferredItem[] = []
  private sends: SendRow[] = []
  async init(): Promise<void> {}
  async bumpDaily(userId: string, localDate: string): Promise<number> {
    // 对应 Redis 的 INCR：先占坑再判断，避免"先查后写"在并发下超发
    const key = `${userId}/${localDate}`
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return next
  }
  async releaseDaily(userId: string, localDate: string): Promise<void> {
    const key = `${userId}/${localDate}`
    this.counters.set(key, Math.max(0, (this.counters.get(key) ?? 0) - 1))
  }
  async dailyUsed(userId: string, localDate: string): Promise<number> {
    return this.counters.get(`${userId}/${localDate}`) ?? 0
  }
  async pushDeferred(item: DeferredItem): Promise<void> {
    this.deferred.push(item)
  }
  async popDue(nowMs: number): Promise<DeferredItem[]> {
    // 真实实现走 Redis ZSET 的按 score 范围查询，这里为了看清楚用线性扫
    const due = this.deferred.filter((item) => item.dueAtMs <= nowMs)
    this.deferred = this.deferred.filter((item) => item.dueAtMs > nowMs)
    return due
  }
  async recordSend(row: SendRow): Promise<void> {
    if (this.sends.some((s) => s.idempotencyKey === row.idempotencyKey)) return
    this.sends.push(row)
  }
  async allSends(): Promise<SendRow[]> {
    return [...this.sends]
  }
  async close(): Promise<void> {}
}

export function createMemoryInfra(): Infra {
  return { store: new MemoryStore(), mode: 'memory' }
}

/** 唯一的选择点。动态 import 让 MOCK=1 的路径完全不加载 ioredis / pg。 */
export async function createInfra(): Promise<Infra> {
  const redisUrl = process.env.REDIS_URL
  const databaseUrl = process.env.DATABASE_URL
  if (!redisUrl || !databaseUrl) return createMemoryInfra()
  const { createRealInfra } = await import('./real')
  return createRealInfra(redisUrl, databaseUrl)
}
