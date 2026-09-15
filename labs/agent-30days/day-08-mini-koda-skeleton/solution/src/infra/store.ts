import { canTransition } from '../shared/schema.js'
import type { MessageRow, RunRow, RunStatus } from '../shared/schema.js'

export interface CreateRunInput {
  sessionId: string
  input: string
  idempotencyKey: string
}

export interface AppendMessageInput {
  id: string
  sessionId: string
  runId: string
  role: string
  content: string
  seq: number
}

export interface CreateRunResult {
  run: RunRow
  /** false 表示这条 run 之前就存在（幂等键撞上了），本次没有新建 */
  created: boolean
}

/** 存储端口。内存版与 Postgres 版实现同一个接口，业务代码只认接口，一行都不用改。 */
export interface Store {
  ensureSession(input: { id: string; userId: string; title: string }): Promise<void>
  /** 幂等插入：撞上 idempotency_key 时返回已有的那条，created 为 false */
  createRun(input: CreateRunInput): Promise<CreateRunResult>
  getRun(runId: string): Promise<RunRow | undefined>
  /** 条件更新：只有当前状态等于 from 才改，返回是否真的改到了 */
  setRunStatus(runId: string, from: RunStatus, to: RunStatus): Promise<boolean>
  /** 违反 unique(run_id, seq) 时返回 false，不抛异常 */
  appendMessage(input: AppendMessageInput): Promise<boolean>
  listPendingRuns(limit: number): Promise<RunRow[]>
  listRunsBySession(sessionId: string): Promise<RunRow[]>
  listMessagesByRun(runId: string): Promise<MessageRow[]>
  close(): Promise<void>
}

export class IllegalTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`非法状态迁移：${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/**
 * 状态迁移的唯一入口——业务逻辑只写一遍，两种存储实现共用。
 * 先查白名单（挡住 done → running 这类会覆盖已有回复的迁移），
 * 再做条件更新（挡住两个 Worker 同时拿到同一条 run 的竞态）。
 */
export async function transitionRun(store: Store, runId: string, to: RunStatus): Promise<RunRow> {
  const run = await store.getRun(runId)
  if (!run) throw new Error(`run 不存在：${runId}`)
  if (!canTransition(run.status, to)) throw new IllegalTransitionError(run.status, to)
  const changed = await store.setRunStatus(runId, run.status, to)
  if (!changed) throw new Error(`并发冲突：${runId} 的状态已经被别人改掉了`)
  const updated = await store.getRun(runId)
  if (!updated) throw new Error(`run 不存在：${runId}`)
  return updated
}
