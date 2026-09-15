import { createHash, randomUUID } from 'node:crypto'
import type { InferSelectModel } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

/** 正常路径 pending → running → streaming → done；异常出口 failed / cancelled。 */
export const RUN_STATUSES = [
  'pending',
  'running',
  'streaming',
  'done',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** 迁移白名单：没列在这里的迁移一律拒绝。 */
const ALLOWED: Record<RunStatus, ReadonlySet<RunStatus>> = {
  // pending 也能直接进 failed：毒消息可能在 run 还没跑起来时就被判死（D9 会用到）
  pending: new Set(['running', 'cancelled', 'failed']),
  running: new Set(['streaming', 'done', 'failed', 'cancelled']),
  streaming: new Set(['done', 'failed', 'cancelled']),
  // 三个终态一律不许再往外走：一个已经 done 的 run 被推回 running，
  // Worker 会再跑一遍并覆盖用户已经收到的回复。
  done: new Set(),
  failed: new Set(),
  cancelled: new Set(),
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  // 练习 3：查上面的 ALLOWED 白名单，返回这次迁移是否被允许。
  // 提示：一个已经 done 的 run 被推回 running，Worker 会再跑一遍并覆盖用户收到的回复。
  // 这个默认值放行一切迁移，自检第 4 项会告诉你后果。
  void [from, to]
  return true
}

/**
 * 幂等键必须由请求内容决定：随机值每次都不一样，唯一约束永远不会冲突，等于没有幂等。
 * 客户端带了消息 id 就用它，没带就退回用消息内容。
 */
export function idempotencyKeyFor(
  sessionId: string,
  clientMessageId: string | undefined,
  message: string
): string {
  // 练习 1：用 sessionId + 客户端消息 id（没有就退回消息内容）算一个稳定的哈希。
  // 提示：下面这个随机值每次都不一样，唯一约束永远不会冲突，等于没有幂等（自检第 3 项）。
  void [sessionId, clientMessageId, message, createHash]
  return randomUUID()
}

/**
 * 应用侧生成 id，不用数据库自增：Gateway 必须在写库之前就把 runId 放进 202 的响应体。
 * 前缀是时间戳的 36 进制，保证大致有序，插入落在 B 树右端。
 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)]
)

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    // $type 把 text 列收窄成六个字面量的联合类型，写错状态名是编译错误
    status: text('status').notNull().$type<RunStatus>(),
    // 唯一约束才是幂等的最终裁判，应用层的判断只是为了少一次插入尝试
    idempotencyKey: text('idempotency_key').notNull().unique(),
    input: text('input').notNull(),
    error: text('error'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('runs_session_id_idx').on(t.sessionId)]
)

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    runId: text('run_id').references(() => runs.id),
    role: text('role').notNull(),
    content: text('content').notNull(),
    seq: integer('seq').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_session_id_idx').on(t.sessionId),
    // seq 从 0 开始、连续、不跳号：D11 的断线重连按它续传
    unique('messages_run_seq_uq').on(t.runId, t.seq),
  ]
)

export type SessionRow = InferSelectModel<typeof sessions>
export type RunRow = InferSelectModel<typeof runs>
export type MessageRow = InferSelectModel<typeof messages>
