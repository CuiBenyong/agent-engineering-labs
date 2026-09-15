import type { MessageRow, RunRow, RunStatus, SessionRow } from '../shared/schema.js'
import type { AppendMessageInput, CreateRunInput, CreateRunResult, Store } from './store.js'
import { newId } from '../shared/schema.js'

/**
 * 内存版存储。它不是打桩——数据库那几条约束的语义在这里被真实实现了一遍：
 * idempotency_key 唯一索引、unique(run_id, seq) 复合唯一索引、状态的条件更新。
 * 真实实现靠 B 树索引，这里为了看清楚用 Map 与 Set 硬写。
 */
export class MemoryStore implements Store {
  private readonly sessions = new Map<string, SessionRow>()
  private readonly runs = new Map<string, RunRow>()
  private readonly messages: MessageRow[] = []
  /** 模拟 runs.idempotency_key 的唯一索引：键 → runId */
  private readonly runByKey = new Map<string, string>()
  /** 模拟 unique(run_id, seq) 的复合唯一索引 */
  private readonly messageKeys = new Set<string>()

  async ensureSession(input: { id: string; userId: string; title: string }): Promise<void> {
    if (this.sessions.has(input.id)) return
    const now = new Date()
    this.sessions.set(input.id, { ...input, createdAt: now, updatedAt: now })
  }

  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    // 幂等键撞上就回查已有的那条——等价于 on conflict do nothing 之后再 select
    const existingId = this.runByKey.get(input.idempotencyKey)
    if (existingId) {
      const existing = this.runs.get(existingId)
      if (existing) return { run: existing, created: false }
    }
    const now = new Date()
    const run: RunRow = {
      id: newId('run'),
      sessionId: input.sessionId,
      status: 'pending',
      idempotencyKey: input.idempotencyKey,
      input: input.input,
      error: null,
      promptTokens: 0,
      completionTokens: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.runs.set(run.id, run)
    this.runByKey.set(run.idempotencyKey, run.id)
    return { run, created: true }
  }

  async getRun(runId: string): Promise<RunRow | undefined> {
    return this.runs.get(runId)
  }

  async setRunStatus(runId: string, from: RunStatus, to: RunStatus): Promise<boolean> {
    const run = this.runs.get(runId)
    // 条件更新：当前状态不等于 from 就什么都不做，对应 SQL 的 where status = $from
    if (!run || run.status !== from) return false
    this.runs.set(runId, { ...run, status: to, updatedAt: new Date() })
    return true
  }

  async appendMessage(input: AppendMessageInput): Promise<boolean> {
    const key = `${input.runId}#${input.seq}`
    // unique(run_id, seq)：同一次执行的同一个序号只能写一次
    if (this.messageKeys.has(key)) return false
    this.messageKeys.add(key)
    this.messages.push({ ...input, createdAt: new Date() })
    return true
  }

  async listPendingRuns(limit: number): Promise<RunRow[]> {
    // 真实实现走索引，这里为了看清楚用全表扫描
    return [...this.runs.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
  }

  async listRunsBySession(sessionId: string): Promise<RunRow[]> {
    return [...this.runs.values()].filter((r) => r.sessionId === sessionId)
  }

  async listMessagesByRun(runId: string): Promise<MessageRow[]> {
    return this.messages.filter((m) => m.runId === runId).sort((a, b) => a.seq - b.seq)
  }

  async close(): Promise<void> {}
}
