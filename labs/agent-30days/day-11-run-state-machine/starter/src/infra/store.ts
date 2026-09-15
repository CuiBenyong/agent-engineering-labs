import { Pool } from 'pg'
import type { Run, RunStatus } from '../shared/run.js'

export interface DeltaRow {
  seq: number
  content: string
}
export interface NewRun {
  id: string
  sessionId: string
  idempotencyKey: string
  input: string
}
export interface NewDelta {
  id: string
  sessionId: string
  runId: string
  seq: number
  content: string
}

/**
 * 三张表的端口（schema 是 D8 定稿的，本天一列都不加；sessions 表 D8 已经建过，这里不重复）。
 * 内存版（MOCK=1）与 Postgres 版（设了 DATABASE_URL）实现同一套语义，其中两条是本天的地基：
 * 1. createRun 撞上 idempotency_key 时返回**已存在的那一行**，不新建（D8 的唯一约束）；
 * 2. insertDelta 撞上 unique(run_id, seq) 时静默忽略，这是幂等回放的兜底。
 */
export interface Store {
  init(): Promise<void>
  createRun(run: NewRun): Promise<Run>
  getRun(id: string): Promise<Run | undefined>
  latestRun(sessionId: string): Promise<Run | undefined>
  setStatus(id: string, status: RunStatus, error?: string): Promise<void>
  appendInput(id: string, text: string): Promise<void>
  insertDelta(row: NewDelta): Promise<void>
  listDeltas(runId: string, fromSeq: number): Promise<DeltaRow[]>
  /** 仅自测使用：把 created_at 往前挪，模拟「这个 run 是 31 秒前创建的」 */
  shiftCreatedAt(id: string, ms: number): Promise<void>
  close(): Promise<void>
}

class MemoryStore implements Store {
  private readonly runs = new Map<string, Run>()
  private readonly deltas = new Map<string, Map<number, string>>()

  async init(): Promise<void> {}

  async createRun(run: NewRun): Promise<Run> {
    for (const existing of this.runs.values()) {
      if (existing.idempotencyKey === run.idempotencyKey) return { ...existing }
    }
    const now = Date.now()
    const created: Run = {
      ...run,
      status: 'pending',
      error: null,
      promptTokens: 0,
      completionTokens: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.runs.set(created.id, created)
    return { ...created }
  }

  async getRun(id: string): Promise<Run | undefined> {
    const run = this.runs.get(id)
    return run ? { ...run } : undefined
  }

  async latestRun(sessionId: string): Promise<Run | undefined> {
    let latest: Run | undefined
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId && (!latest || run.createdAt > latest.createdAt)) latest = run
    }
    return latest ? { ...latest } : undefined
  }

  async setStatus(id: string, status: RunStatus, error?: string): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    run.status = status
    run.error = error ?? run.error
    run.updatedAt = Date.now()
  }

  async appendInput(id: string, text: string): Promise<void> {
    const run = this.runs.get(id)
    if (run) run.input = `${run.input}\n${text}`
  }

  async insertDelta(row: NewDelta): Promise<void> {
    let perRun = this.deltas.get(row.runId)
    if (!perRun) this.deltas.set(row.runId, (perRun = new Map<number, string>()))
    // Map 的键唯一，正好对应 unique(run_id, seq)：重复写同一号是空操作
    if (!perRun.has(row.seq)) perRun.set(row.seq, row.content)
  }

  async listDeltas(runId: string, fromSeq: number): Promise<DeltaRow[]> {
    return [...(this.deltas.get(runId) ?? new Map<number, string>()).entries()]
      .filter(([seq]) => seq >= fromSeq)
      .sort((a, b) => a[0] - b[0])
      .map(([seq, content]) => ({ seq, content }))
  }

  async shiftCreatedAt(id: string, ms: number): Promise<void> {
    const run = this.runs.get(id)
    if (run) run.createdAt += ms
  }

  async close(): Promise<void> {}
}

interface RunRow {
  id: string
  session_id: string
  status: string
  idempotency_key: string
  input: string
  error: string | null
  prompt_tokens: number
  completion_tokens: number
  created_at: Date
  updated_at: Date
}

const toRun = (row: RunRow): Run => ({
  id: row.id,
  sessionId: row.session_id,
  status: row.status as RunStatus,
  idempotencyKey: row.idempotency_key,
  input: row.input,
  error: row.error,
  promptTokens: row.prompt_tokens,
  completionTokens: row.completion_tokens,
  createdAt: row.created_at.getTime(),
  updatedAt: row.updated_at.getTime(),
})

/** 真实版：同一份业务代码，换掉的只有这个类。 */
class PgStore implements Store {
  private readonly pool: Pool
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url })
  }

  async init(): Promise<void> {
    // 建表写在这里只是为了让 lab 一条命令能跑起来；真实项目用 D8 的 drizzle-kit 迁移
    await this.pool.query(`
      create table if not exists runs (
        id text primary key, session_id text not null, status text not null,
        idempotency_key text not null unique, input text not null, error text,
        prompt_tokens int not null default 0, completion_tokens int not null default 0,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create index if not exists runs_session_id_idx on runs (session_id);
      create table if not exists messages (
        id text primary key, session_id text not null, run_id text references runs (id),
        role text not null, content text not null, seq int not null,
        created_at timestamptz not null default now(), unique (run_id, seq));
      create index if not exists messages_session_id_idx on messages (session_id);`)
  }

  async createRun(run: NewRun): Promise<Run> {
    // 幂等键撞了就什么都不做，再把已存在的那一行读回来——D8 那条唯一约束在本天的第一次使用
    await this.pool.query(
      `insert into runs (id, session_id, status, idempotency_key, input)
       values ($1, $2, 'pending', $3, $4) on conflict (idempotency_key) do nothing`,
      [run.id, run.sessionId, run.idempotencyKey, run.input]
    )
    const res = await this.pool.query<RunRow>(`select * from runs where idempotency_key = $1`, [
      run.idempotencyKey,
    ])
    return toRun(res.rows[0])
  }

  async getRun(id: string): Promise<Run | undefined> {
    const res = await this.pool.query<RunRow>(`select * from runs where id = $1`, [id])
    return res.rows[0] ? toRun(res.rows[0]) : undefined
  }

  async latestRun(sessionId: string): Promise<Run | undefined> {
    const res = await this.pool.query<RunRow>(
      `select * from runs where session_id = $1 order by created_at desc limit 1`,
      [sessionId]
    )
    return res.rows[0] ? toRun(res.rows[0]) : undefined
  }

  async setStatus(id: string, status: RunStatus, error?: string): Promise<void> {
    await this.pool.query(
      `update runs set status = $2, error = coalesce($3, error), updated_at = now() where id = $1`,
      [id, status, error ?? null]
    )
  }

  async appendInput(id: string, text: string): Promise<void> {
    await this.pool.query(
      `update runs set input = input || E'\\n' || $2, updated_at = now() where id = $1`,
      [id, text]
    )
  }

  async insertDelta(row: NewDelta): Promise<void> {
    await this.pool.query(
      `insert into messages (id, session_id, run_id, role, content, seq)
       values ($1, $2, $3, 'assistant', $4, $5) on conflict (run_id, seq) do nothing`,
      [row.id, row.sessionId, row.runId, row.content, row.seq]
    )
  }

  async listDeltas(runId: string, fromSeq: number): Promise<DeltaRow[]> {
    const res = await this.pool.query<DeltaRow>(
      `select seq, content from messages where run_id = $1 and seq >= $2 order by seq asc`,
      [runId, fromSeq]
    )
    return res.rows
  }

  async shiftCreatedAt(id: string, ms: number): Promise<void> {
    await this.pool.query(
      `update runs set created_at = created_at + ($2 || ' milliseconds')::interval where id = $1`,
      [id, String(ms)]
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** 唯一的选择点：设了 DATABASE_URL 就连真 Postgres，否则用内存实现。 */
export function createStore(): Store {
  const url = process.env.DATABASE_URL
  if (url) {
    console.log('[infra] Store = Postgres')
    return new PgStore(url)
  }
  console.log('[infra] Store = 内存实现（未设置 DATABASE_URL）')
  return new MemoryStore()
}
