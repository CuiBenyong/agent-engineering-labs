import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { messages, newId, runs, sessions } from '../shared/schema.js'
import type { MessageRow, RunRow, RunStatus } from '../shared/schema.js'
import type { AppendMessageInput, CreateRunInput, CreateRunResult, Store } from './store.js'

/** Postgres 版存储：唯一约束、复合唯一约束、条件更新全部交给数据库裁决。 */
export class PgStore implements Store {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly db: ReturnType<typeof drizzle>
  ) {}

  static async connect(connectionString: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString })
    const db = drizzle(pool)
    // 迁移是一条有序的链：按 drizzle/ 下的序号依次执行，执行记录写进 __drizzle_migrations
    await migrate(db, { migrationsFolder: 'drizzle' })
    return new PgStore(pool, db)
  }

  async ensureSession(input: { id: string; userId: string; title: string }): Promise<void> {
    await this.db.insert(sessions).values(input).onConflictDoNothing({ target: sessions.id })
  }

  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    // on conflict (idempotency_key) do nothing：冲突时返回零行，回查那条已有的 run
    const inserted = await this.db
      .insert(runs)
      .values({
        id: newId('run'),
        sessionId: input.sessionId,
        status: 'pending',
        idempotencyKey: input.idempotencyKey,
        input: input.input,
      })
      .onConflictDoNothing({ target: runs.idempotencyKey })
      .returning()
    if (inserted[0]) return { run: inserted[0], created: true }

    const existing = await this.db
      .select()
      .from(runs)
      .where(eq(runs.idempotencyKey, input.idempotencyKey))
    if (!existing[0]) throw new Error('幂等键冲突但回查不到，检查是否有别的事务回滚了')
    return { run: existing[0], created: false }
  }

  async getRun(runId: string): Promise<RunRow | undefined> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, runId))
    return rows[0]
  }

  async setRunStatus(runId: string, from: RunStatus, to: RunStatus): Promise<boolean> {
    // where id = ? and status = ?：条件更新，两个 Worker 抢同一条 run 时只有一个改得动
    const updated = await this.db
      .update(runs)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(runs.id, runId), eq(runs.status, from)))
      .returning({ id: runs.id })
    return updated.length > 0
  }

  async appendMessage(input: AppendMessageInput): Promise<boolean> {
    // 复合唯一约束由数据库把关，不需要先查一遍
    const rows = await this.db
      .insert(messages)
      .values(input)
      .onConflictDoNothing({ target: [messages.runId, messages.seq] })
      .returning({ id: messages.id })
    return rows.length > 0
  }

  async listPendingRuns(limit: number): Promise<RunRow[]> {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.status, 'pending'))
      .orderBy(asc(runs.createdAt))
      .limit(limit)
  }

  async listRunsBySession(sessionId: string): Promise<RunRow[]> {
    return this.db.select().from(runs).where(eq(runs.sessionId, sessionId))
  }

  async listMessagesByRun(runId: string): Promise<MessageRow[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.runId, runId))
      .orderBy(asc(messages.seq))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
