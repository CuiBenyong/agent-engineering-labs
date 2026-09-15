import Redis from 'ioredis'
import { Pool } from 'pg'
import type { DeferredItem, Infra, SendRow, Store } from './index'

// 真实实现：Redis（计数器 + 延后队列）+ Postgres（发送流水）。业务代码一行都不用改，
// 差别只在这个文件里。`docker compose up -d` 之后设好 REDIS_URL 与 DATABASE_URL 即可切过来。
const DDL = `
create table if not exists notifications (
  id                  text        primary key,
  user_id             text        not null,
  channel             text        not null,
  idempotency_key     text        not null unique,
  title               text        not null,
  body                text        not null,
  provider_message_id text        not null,
  sent_at             timestamptz not null
);
create index if not exists notifications_user_id_idx on notifications (user_id);`

class RealStore implements Store {
  private redis: Redis
  private pool: Pool
  constructor(redisUrl: string, databaseUrl: string) {
    this.redis = new Redis(redisUrl)
    this.pool = new Pool({ connectionString: databaseUrl })
  }
  async init(): Promise<void> {
    await this.pool.query(DDL)
  }
  private key(userId: string, localDate: string): string {
    return `notify:count:${userId}:${localDate}`
  }
  async bumpDaily(userId: string, localDate: string): Promise<number> {
    const key = this.key(userId, localDate)
    const next = await this.redis.incr(key)
    // 两天后自动清理：本地日历日最多比 UTC 日错开一天，留足余量
    if (next === 1) await this.redis.expire(key, 172_800)
    return next
  }
  async releaseDaily(userId: string, localDate: string): Promise<void> {
    await this.redis.decr(this.key(userId, localDate))
  }
  async dailyUsed(userId: string, localDate: string): Promise<number> {
    return Number((await this.redis.get(this.key(userId, localDate))) ?? 0)
  }
  async pushDeferred(item: DeferredItem): Promise<void> {
    // ZSET 的 score 就是到期时刻，按 score 取范围天然就是"取出所有到期的"
    await this.redis.zadd('notify:deferred', item.dueAtMs, JSON.stringify(item))
  }
  async popDue(nowMs: number): Promise<DeferredItem[]> {
    const raw = await this.redis.zrangebyscore('notify:deferred', '-inf', nowMs)
    if (raw.length === 0) return []
    // 先取后删有极小的重复取出窗口，靠下游的 idempotencyKey 兜底（D8 那一招）
    await this.redis.zrem('notify:deferred', ...raw)
    return raw.map((s) => JSON.parse(s) as DeferredItem)
  }
  async recordSend(row: SendRow): Promise<void> {
    await this.pool.query(
      `insert into notifications
         (id, user_id, channel, idempotency_key, title, body, provider_message_id, sent_at)
       values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
       on conflict (idempotency_key) do nothing`,
      [
        row.id,
        row.userId,
        row.channel,
        row.idempotencyKey,
        row.title,
        row.body,
        row.providerMessageId,
        row.sentAtMs,
      ]
    )
  }
  async allSends(): Promise<SendRow[]> {
    const res = await this.pool.query(
      `select id, user_id, channel, idempotency_key, title, body,
              provider_message_id, extract(epoch from sent_at) * 1000 as sent_at_ms
       from notifications order by sent_at`
    )
    return res.rows.map((r: Record<string, string>) => ({
      id: r.id,
      userId: r.user_id,
      channel: r.channel,
      idempotencyKey: r.idempotency_key,
      title: r.title,
      body: r.body,
      providerMessageId: r.provider_message_id,
      sentAtMs: Number(r.sent_at_ms),
    }))
  }
  async close(): Promise<void> {
    await this.redis.quit()
    await this.pool.end()
  }
}

export function createRealInfra(redisUrl: string, databaseUrl: string): Infra {
  return { store: new RealStore(redisUrl, databaseUrl), mode: 'real' }
}
