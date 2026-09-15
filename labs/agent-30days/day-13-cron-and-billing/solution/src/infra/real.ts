import Redis from 'ioredis'
import { Pool } from 'pg'
import type { Bus, BusMessage, Infra, RunRow, Store, UsageRow } from './index'

// 真实实现：Redis Streams + Postgres。业务代码一行都不用改，差别只在这个文件里。
// `docker compose up -d` 之后设好 REDIS_URL 与 DATABASE_URL、去掉 MOCK=1 即可切过来。
class RedisBus implements Bus {
  private redis: Redis
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
  async readGroup(stream: string, group: string, consumer: string, count: number) {
    const args = ['COUNT', count, 'BLOCK', 500, 'STREAMS', stream, '>'] as const
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
  async close(): Promise<void> {
    await this.redis.quit()
  }
}

/** sessions / runs 来自 D8，本天不改；usage_ledger 是今天新增的那一张。 */
const DDL = `
create table if not exists sessions (
  id text primary key, user_id text not null, title text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists runs (
  id text primary key, session_id text not null references sessions(id), status text not null,
  idempotency_key text not null unique, input text not null, error text,
  prompt_tokens integer not null default 0, completion_tokens integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists usage_ledger (
  id text primary key, user_id text not null, run_id text, model text not null, kind text not null,
  prompt_tokens integer not null, completion_tokens integer not null,
  cost_usd numeric(12, 6) not null, created_at timestamptz not null default now());
create index if not exists usage_ledger_user_id_idx on usage_ledger (user_id);
create index if not exists usage_ledger_created_at_idx on usage_ledger (created_at);`

// 列别名让 Postgres 直接返回 camelCase，省掉一层逐字段 map
const SELECT_USAGE = `select id, user_id as "userId", run_id as "runId", model, kind,
  prompt_tokens as "promptTokens", completion_tokens as "completionTokens",
  cost_usd as "costUsd", created_at as "createdAt"
from usage_ledger order by created_at`

type UsageDbRow = Omit<UsageRow, 'costMicroUsd' | 'createdAt'> & {
  costUsd: string
  createdAt: Date
}

class PgStore implements Store {
  private pool: Pool
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url })
  }
  async init(): Promise<void> {
    await this.pool.query(DDL)
  }
  async insertRun(row: RunRow): Promise<boolean> {
    await this.pool.query(
      'insert into sessions (id, user_id, title) values ($1, $2, $3) on conflict do nothing',
      [row.sessionId, row.userId, row.sessionId]
    )
    // 唯一约束挡重复：插进去返回 1 行，撞上就返回 0 行——「不重复执行」的全部机制就在这里
    const res = await this.pool.query(
      `insert into runs (id, session_id, status, idempotency_key, input)
       values ($1, $2, 'running', $3, $4) on conflict (idempotency_key) do nothing`,
      [row.id, row.sessionId, row.key, row.input]
    )
    return res.rowCount === 1
  }
  async finishRun(id: string, promptTokens: number, completionTokens: number): Promise<void> {
    await this.pool.query(
      `update runs set status = 'done', prompt_tokens = $2, completion_tokens = $3,
              updated_at = now() where id = $1`,
      [id, promptTokens, completionTokens]
    )
  }
  async insertUsage(row: UsageRow): Promise<void> {
    await this.pool.query(
      `insert into usage_ledger (id, user_id, run_id, model, kind,
         prompt_tokens, completion_tokens, cost_usd, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.userId,
        row.runId,
        row.model,
        row.kind,
        row.promptTokens,
        row.completionTokens,
        // 定点存储：微美元整数除以 100 万，交给 numeric(12,6) 列去精确累加
        (row.costMicroUsd / 1_000_000).toFixed(6),
        row.createdAt,
      ]
    )
  }
  async allUsage(): Promise<UsageRow[]> {
    // 生产里汇总会下推成 SQL 的 group by（见正文）；这里取回明细在 ledger.ts 汇总，
    // 是为了让汇总逻辑只写一遍、两种基础设施实现共用。
    const res = await this.pool.query<UsageDbRow>(SELECT_USAGE)
    return res.rows.map(({ costUsd, createdAt, ...rest }) => ({
      ...rest,
      costMicroUsd: Math.round(Number(costUsd) * 1_000_000),
      createdAt: createdAt.toISOString(),
    }))
  }
  async close(): Promise<void> {
    await this.pool.end()
  }
}

export function createRealInfra(redisUrl: string, databaseUrl: string): Infra {
  return { bus: new RedisBus(redisUrl), store: new PgStore(databaseUrl), mode: 'real' }
}
