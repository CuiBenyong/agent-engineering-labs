/**
 * Postgres 版实现。业务代码一行都不用改——差别全在这个文件里。
 * 起库：在 lab 根目录 `docker compose up -d`，然后
 *   DATABASE_URL=postgres://koda:koda@127.0.0.1:5519/koda
 */
import { Pool } from 'pg'
import type { MemoryRow, MessageRow, UsageRow, UsageSummary } from '../shared/types'
import type { Store, StoreHandle } from './index'

const DDL = `
create table if not exists sessions (
  id         text primary key,
  user_id    text not null,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id         text primary key,
  session_id text not null references sessions (id),
  run_id     text,
  role       text not null,
  content    text not null,
  seq        integer not null,
  created_at timestamptz not null default now(),
  unique (session_id, seq)
);

create table if not exists memories (
  id            text primary key,
  user_id       text not null,
  source_run_id text,
  content       text not null,
  created_at    timestamptz not null default now()
);

-- usage_ledger 来自 D13，字段一字不改（金额是定点数，不是浮点）
create table if not exists usage_ledger (
  id                text           primary key,
  user_id           text           not null,
  run_id            text,
  model             text           not null,
  kind              text           not null,
  prompt_tokens     integer        not null,
  completion_tokens integer        not null,
  cost_usd          numeric(12, 6) not null,
  created_at        timestamptz    not null default now()
);
create index if not exists usage_ledger_user_id_idx on usage_ledger (user_id);

-- D19 新增的唯一一张表。external_id 上那条唯一约束就是幂等的最终裁判。
create table if not exists external_events (
  external_id text primary key,
  kind        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
`

class PgStore implements Store {
  constructor(private pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(DDL)
  }

  async reset(): Promise<void> {
    await this.pool.query(
      'truncate external_events, messages, memories, usage_ledger, sessions restart identity'
    )
  }

  async ensureSession(userId: string): Promise<string> {
    const found = await this.pool.query<{ id: string }>(
      'select id from sessions where user_id = $1 limit 1',
      [userId]
    )
    if (found.rows[0]) return found.rows[0].id
    const id = `s-${crypto.randomUUID()}`
    await this.pool.query('insert into sessions (id, user_id) values ($1, $2)', [id, userId])
    return id
  }

  async insertExternalEvent(externalId: string, kind: string, payload: string): Promise<boolean> {
    // on conflict do nothing：冲突时返回零行，那就是「这条事件之前已经处理过」的权威答案
    const res = await this.pool.query(
      `insert into external_events (external_id, kind, payload)
       values ($1, $2, $3::jsonb)
       on conflict (external_id) do nothing
       returning external_id`,
      [externalId, kind, payload]
    )
    return res.rowCount === 1
  }

  async countExternalEvents(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      'select count(*)::text as n from external_events'
    )
    return Number(res.rows[0]?.n ?? '0')
  }

  async insertMessage(row: MessageRow): Promise<void> {
    await this.pool.query(
      'insert into messages (id, session_id, run_id, role, content, seq) values ($1,$2,$3,$4,$5,$6)',
      [row.id, row.sessionId, row.runId, row.role, row.content, row.seq]
    )
  }

  async listMessages(sessionId: string): Promise<MessageRow[]> {
    const res = await this.pool.query(
      'select id, session_id, run_id, role, content, seq from messages where session_id = $1 order by seq',
      [sessionId]
    )
    return res.rows.map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      runId: (r.run_id as string | null) ?? null,
      role: r.role as string,
      content: r.content as string,
      seq: r.seq as number,
    }))
  }

  async insertMemory(row: MemoryRow): Promise<void> {
    await this.pool.query(
      'insert into memories (id, user_id, source_run_id, content) values ($1,$2,$3,$4)',
      [row.id, row.userId, row.sourceRunId, row.content]
    )
  }

  async listMemories(userId: string): Promise<MemoryRow[]> {
    const res = await this.pool.query(
      'select id, user_id, source_run_id, content, created_at from memories where user_id = $1 order by created_at',
      [userId]
    )
    return res.rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      sourceRunId: (r.source_run_id as string | null) ?? null,
      content: r.content as string,
      createdAt: String(r.created_at),
    }))
  }

  async insertUsage(row: UsageRow): Promise<void> {
    await this.pool.query(
      `insert into usage_ledger
         (id, user_id, run_id, model, kind, prompt_tokens, completion_tokens, cost_usd)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id,
        row.userId,
        row.runId,
        row.model,
        row.kind,
        row.promptTokens,
        row.completionTokens,
        // 内存里按微美元整数加总，落库这一步才写成 numeric 的六位小数（D13 的口径）
        (row.costMicroUsd / 1_000_000).toFixed(6),
      ]
    )
  }

  async usageSummary(userId: string): Promise<UsageSummary> {
    const res = await this.pool.query(
      `select count(*)::text as calls,
              coalesce(sum(prompt_tokens), 0)::text     as prompt_tokens,
              coalesce(sum(completion_tokens), 0)::text as completion_tokens,
              coalesce(sum(cost_usd), 0)::text          as cost_usd
         from usage_ledger where user_id = $1`,
      [userId]
    )
    const row = res.rows[0]
    return {
      calls: Number(row?.calls ?? '0'),
      promptTokens: Number(row?.prompt_tokens ?? '0'),
      completionTokens: Number(row?.completion_tokens ?? '0'),
      costMicroUsd: Math.round(Number(row?.cost_usd ?? '0') * 1_000_000),
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export function createPgStore(databaseUrl: string): StoreHandle {
  return { store: new PgStore(new Pool({ connectionString: databaseUrl })), mode: 'real' }
}
