/**
 * run 的状态枚举（D8 定稿，本天展开讲）。
 * pending → running → streaming → done 是正常路径；
 * failed（重试耗尽）与 cancelled（被打断合并或用户取消）是两个异常出口。
 */
export type RunStatus = 'pending' | 'running' | 'streaming' | 'done' | 'failed' | 'cancelled'

/** runs 表的一行。字段与 D8 定稿的 schema 一一对应，不多不少。 */
export interface Run {
  id: string
  sessionId: string
  status: RunStatus
  idempotencyKey: string
  input: string
  error: string | null
  promptTokens: number
  completionTokens: number
  createdAt: number
  updatedAt: number
}

/** 输入流：gateway 投递「有一个 run 要执行」，worker 消费（D9 定的名字） */
export const RUNS_STREAM = 'koda:runs'
/** 消费组名（D9 定） */
export const GROUP = 'workers'
/** 输出流：一个 run 一条，worker 往里写片段，gateway 读出来推给 SSE */
export const outStream = (runId: string): string => `koda:out:${runId}`
/**
 * 「需要重跑」的瞬态标记。
 * 它**故意不进 runs 表**：这是一个只在本次执行期间有意义的控制信号，
 * 写进业务表会让「持久状态」和「控制信号」混在一起，重启后还得先清理一遍脏标记。
 * 放一个带 TTL 的 Redis 键上，进程挂了它自己会过期。
 */
export const rerunKey = (runId: string): string => `koda:rerun:${runId}`

/** 打断合并窗口：30 秒（全周固定值） */
export const MERGE_WINDOW_MS = 30_000

/**
 * 合法转换表。终态没有出边——这是整张表最值钱的一行：
 * 它让「done 之后又收到一个片段」这类 bug 在写入那一刻就被拦住，
 * 而不是变成用户在页面上看到的乱序回复。
 */
export const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  pending: ['running', 'cancelled', 'failed'],
  running: ['streaming', 'done', 'failed', 'cancelled'],
  streaming: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
}

export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0
}

/** 这一步转换合法吗。查表，不要写成一串 if——状态机的价值就在于它是一张能被读、能被测的表。 */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 转换或抛错。所有写状态的地方都必须过这里，否则状态机就只是注释。 */
export function transition(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransition(from, to)) throw new Error(`非法状态转换：${from} → ${to}`)
  return to
}

/**
 * 打断合并判据（三个条件全中才合并）：
 * 1. 同一个 sessionId 的上一个 run；
 * 2. 它正处于 running 或 streaming——已经 done 的说完了，合并进去没有意义；
 * 3. 距它创建不到 30 秒。
 * pending 不在合并范围内：那段窗口通常只有几毫秒，把它排除掉，
 * 判据就不用考虑「worker 正好在这一刻读 input」的竞态。
 */
export function shouldMerge(prev: Run | undefined, now: number): boolean {
  if (!prev) return false
  if (prev.status !== 'running' && prev.status !== 'streaming') return false
  return now - prev.createdAt < MERGE_WINDOW_MS
}
