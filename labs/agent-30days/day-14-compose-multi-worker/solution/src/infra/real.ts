import Redis from 'ioredis'
import { Pool } from 'pg'
import type {
  Bus,
  BusMessage,
  HeartbeatRow,
  Infra,
  LeaseStore,
  PresenceStore,
  RunRow,
  RunStatus,
  RunStore,
} from './index'

// 真实实现：Redis Streams + Redis 键 + Postgres。业务代码一行都不用改，
// `docker compose up -d` 之后设好 REDIS_URL 与 DATABASE_URL、去掉 MOCK=1 就切过来了。

class RedisBus implements Bus {
  private readonly redis: Redis
  constructor(url: string) {
    this.redis = new Redis(url)
  }
  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
    } catch (err) {
      // BUSYGROUP 表示组已存在，属正常情况；别的错误照抛
      if (!String(err).includes('BUSYGROUP')) throw err
    }
  }
  async publish(stream: string, fields: Record<string, string>): Promise<string> {
    return (await this.redis.xadd(stream, '*', ...Object.entries(fields).flat())) ?? ''
  }
  async readGroup(
    stream: string,
    group: string,
    consumer: string,
    count: number
  ): Promise<BusMessage[]> {
    // BLOCK 给 200 毫秒而不是几秒：优雅停机要能很快地「停止取新消息」，
    // 阻塞时间就是停机时最坏要多等的那一段。
    const args = ['COUNT', count, 'BLOCK', 200, 'STREAMS', stream, '>'] as const
    const raw = await this.redis.xreadgroup('GROUP', group, consumer, ...args)
    const out: BusMessage[] = []
    for (const [, entries] of (raw ?? []) as [string, [string, string[]][]][]) {
      for (const [id, flat] of entries) {
        const fields: Record<string, string> = {}
        for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1]
        out.push({ id, fields })
      }
    }
    return out
  }
  async ack(stream: string, group: string, ids: string[]): Promise<number> {
    return ids.length === 0 ? 0 : this.redis.xack(stream, group, ...ids)
  }
  async len(stream: string): Promise<number> {
    return this.redis.xlen(stream)
  }
  async close(): Promise<void> {
    await this.redis.quit()
  }
}

// 续约与交还都要「先确认牌子上是我的名字」，所以都得走 Lua——
// GET 之后再 DEL 中间那一瞬间租约可能已经易主，你删的就是别人的牌子（D10）。
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`

class RedisLeaseStore implements LeaseStore {
  private readonly redis: Redis
  constructor(url: string) {
    this.redis = new Redis(url)
  }
  async tryAcquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(key, owner, 'PX', ttlMs, 'NX')) === 'OK'
  }
  async renewIfOwner(key: string, owner: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(RENEW_LUA, 1, key, owner, String(ttlMs))) === 1
  }
  async releaseIfOwner(key: string, owner: string): Promise<boolean> {
    return (await this.redis.eval(RELEASE_LUA, 1, key, owner)) === 1
  }
  async owner(key: string): Promise<string | null> {
    return this.redis.get(key)
  }
  async close(): Promise<void> {
    await this.redis.quit()
  }
}

class RedisPresenceStore implements PresenceStore {
  private readonly redis: Redis
  constructor(url: string) {
    this.redis = new Redis(url)
  }
  // 用一个 hash 而不是每个 worker 一个带 TTL 的键：TTL 会自动清理，
  // 但键一过期「最后心跳时间」也跟着没了，面板就只能显示「不存在」而不是「失联 23 秒」。
  async beat(key: string, row: HeartbeatRow): Promise<void> {
    await this.redis.hset(key, row.workerId, JSON.stringify(row))
  }
  async list(key: string): Promise<HeartbeatRow[]> {
    const raw = await this.redis.hgetall(key)
    return Object.values(raw)
      .map((value) => JSON.parse(value) as HeartbeatRow)
      .sort((a, b) => a.workerId.localeCompare(b.workerId))
  }
  async forget(key: string, workerId: string): Promise<void> {
    await this.redis.hdel(key, workerId)
  }
  async close(): Promise<void> {
    await this.redis.quit()
  }
}

/** sessions / runs 来自 D8，本天不改 */
const DDL = `
create table if not exists sessions (
  id text primary key, user_id text not null, title text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists runs (
  id text primary key, session_id text not null references sessions(id), status text not null,
  idempotency_key text not null unique, input text not null, error text,
  prompt_tokens integer not null default 0, completion_tokens integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists runs_session_id_idx on runs (session_id);`

class PgRunStore implements RunStore {
  private readonly pool: Pool
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url })
  }
  async init(): Promise<void> {
    await this.pool.query(DDL)
  }
  async createRun(row: RunRow): Promise<boolean> {
    await this.pool.query(
      'insert into sessions (id, user_id, title) values ($1, $2, $3) on conflict do nothing',
      [row.sessionId, row.userId, row.sessionId]
    )
    const res = await this.pool.query(
      `insert into runs (id, session_id, status, idempotency_key, input)
       values ($1, $2, 'pending', $3, $4) on conflict (idempotency_key) do nothing`,
      [row.id, row.sessionId, row.idempotencyKey, row.input]
    )
    return res.rowCount === 1
  }
  async setStatus(id: string, status: RunStatus): Promise<void> {
    await this.pool.query('update runs set status = $2, updated_at = now() where id = $1', [
      id,
      status,
    ])
  }
  async getRun(id: string): Promise<{ id: string; status: RunStatus } | null> {
    const res = await this.pool.query<{ id: string; status: RunStatus }>(
      'select id, status from runs where id = $1',
      [id]
    )
    return res.rows[0] ?? null
  }
  /** 就绪探针只查这一句：证明这台机器自己还能用，不去查下游（见正文） */
  async ping(): Promise<void> {
    await this.pool.query('select 1')
  }
  async close(): Promise<void> {
    await this.pool.end()
  }
}

export function createRealInfra(redisUrl: string, databaseUrl: string): Infra {
  const bus = new RedisBus(redisUrl)
  const lease = new RedisLeaseStore(redisUrl)
  const presence = new RedisPresenceStore(redisUrl)
  const store = new PgRunStore(databaseUrl)
  return {
    mode: 'real',
    bus,
    lease,
    presence,
    store,
    close: async () => {
      await Promise.all([bus.close(), lease.close(), presence.close(), store.close()])
    },
  }
}
