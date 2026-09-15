/**
 * D8 定稿的三张表，字段与列名逐字照抄，本天不改。
 * D8 那边它们在 Postgres 里、用 Drizzle 定义；本天为了让 MOCK=1 零外部服务、
 * 也为了把注意力留给总线，只带一份内存实现——接口是同一个，
 * 把 D8 的 Drizzle 版塞进 createStore 就能换掉，gateway 和 worker 一行不用动。
 */

/** run 状态枚举（D8 定，D11 展开讲）：pending → running → streaming → done，异常出口 failed / cancelled */
export type RunStatus = 'pending' | 'running' | 'streaming' | 'done' | 'failed' | 'cancelled'

// sessions 表（id / user_id / title / created_at / updated_at）由 D8 的 POST /chat 写，
// 本天的链路从「会话已存在」开始，所以这里只带 runs 与 messages。

export interface RunRow {
  id: string
  sessionId: string
  status: RunStatus
  /** unique 约束就在这一列上：重复提交会被它挡住 */
  idempotencyKey: string
  input: string
  error: string | null
  promptTokens: number
  completionTokens: number
  createdAt: Date
  updatedAt: Date
}

export interface MessageRow {
  id: string
  sessionId: string
  runId: string | null
  role: 'user' | 'assistant'
  content: string
  /** unique(run_id, seq)：保序与幂等回放的依据 */
  seq: number
  createdAt: Date
}

export interface Store {
  /** insert ... on conflict (idempotency_key) do nothing；inserted 为 false 就是重复提交 */
  createRun(row: {
    id: string
    sessionId: string
    idempotencyKey: string
    input: string
  }): Promise<{
    run: RunRow
    inserted: boolean
  }>
  getRun(id: string): Promise<RunRow | undefined>
  updateRun(id: string, patch: Partial<RunRow>): Promise<void>
  /** insert ... on conflict (run_id, seq) do nothing */
  insertMessage(row: Omit<MessageRow, 'id' | 'createdAt'>): Promise<{ inserted: boolean }>
  runs(): Promise<RunRow[]>
  messages(): Promise<MessageRow[]>
}

export function createStore(): Store {
  const runRows = new Map<string, RunRow>()
  const messageRows: MessageRow[] = []
  let counter = 0

  return {
    async createRun({ id, sessionId, idempotencyKey, input }) {
      // 这就是 unique(idempotency_key) 在 Postgres 里干的事：已有同键的行就什么都不做，
      // 并把已存在的那一行还给调用方。内存版靠全表扫描，真实版靠唯一索引
      const existing = [...runRows.values()].find((r) => r.idempotencyKey === idempotencyKey)
      if (existing) return { run: existing, inserted: false }
      const now = new Date()
      const run: RunRow = {
        id,
        sessionId,
        status: 'pending',
        idempotencyKey,
        input,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
        createdAt: now,
        updatedAt: now,
      }
      runRows.set(id, run)
      return { run, inserted: true }
    },

    async getRun(id) {
      return runRows.get(id)
    },

    async updateRun(id, patch) {
      const run = runRows.get(id)
      if (run) Object.assign(run, patch, { updatedAt: new Date() })
    },

    async insertMessage(row) {
      // unique(run_id, seq)：同一个 run 的同一个序号只能有一条，
      // 所以就算两个 worker 同时执行了同一条消息，回复也只会落一条
      if (messageRows.some((m) => m.runId === row.runId && m.seq === row.seq)) {
        return { inserted: false }
      }
      counter += 1
      messageRows.push({ ...row, id: `m${counter}`, createdAt: new Date() })
      return { inserted: true }
    },

    async runs() {
      return [...runRows.values()]
    },

    async messages() {
      return [...messageRows]
    },
  }
}
