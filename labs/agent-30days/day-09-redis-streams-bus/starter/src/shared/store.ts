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
      // 练习 1：把这里做成 insert ... on conflict (idempotency_key) do nothing。
      // 已经存在同一个 idempotencyKey 的 run 时，不要新建，把已存在的那一行原样还回去，
      // 并且 inserted 返回 false（gateway 靠它决定「这次不再投递」）。
      // 提示：内存版就是在 runRows 里找一遍；真实版靠 Postgres 的唯一索引，不用自己找。
      // 挖空时的默认行为：每次都新建一条 —— 客户端重试一次 POST /chat 就会多出一个 run
      // 和一条重复回复，自检第 3 项会告诉你 run 总数变成了 4。
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
