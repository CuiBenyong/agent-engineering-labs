import type { RunRow } from '../shared/schema.js'
import type { Store } from '../infra/store.js'

/**
 * 执行层（Worker）今天只做一件只读的事：证明它和 Gateway 看到的是同一份状态。
 * 刻意没有执行任何一条 run，而且用的是轮询——空转浪费、延迟等于轮询间隔、
 * 多个 Worker 会捞到同一条。D9 用 Redis Streams 换成推送加消费组才有真正的消费循环。
 */
export async function inspectPending(store: Store, limit = 10): Promise<RunRow[]> {
  return store.listPendingRuns(limit)
}
