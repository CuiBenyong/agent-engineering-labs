import type { Bus } from '../infra/bus'
import { STREAM } from '../shared/config'
import type { Store } from '../shared/store'

let runSeq = 0

export interface SubmitResult {
  runId: string
  /** true = 这次是重复提交，被 runs.idempotency_key 的唯一约束挡住了，没有再投递 */
  duplicated: boolean
  streamId?: string
}

/**
 * D8 的 POST /chat 落库之后就停住了，今天给它接上最后一步：XADD。
 *
 * 顺序必须是「先落库、再投递」。反过来的话，worker 可能在 run 那一行还没写进去
 * 就把消息捞走了，读到一个不存在的 runId。代价是另一头的洞：落库成功、XADD 失败，
 * 这个 run 会永远停在 pending——生产里靠一个扫描超时 pending run 的补投任务兜底。
 */
export async function submitChat(
  deps: { bus: Bus; store: Store },
  input: { sessionId: string; text: string; idempotencyKey: string }
): Promise<SubmitResult> {
  runSeq += 1
  const { run, inserted } = await deps.store.createRun({
    id: `run-${runSeq}`,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    input: input.text,
  })
  // 重复提交在这里就被挡下了：不写第二条 user 消息，也不投第二条总线消息
  if (!inserted) return { runId: run.id, duplicated: true }

  await deps.store.insertMessage({
    sessionId: input.sessionId,
    runId: run.id,
    role: 'user',
    content: input.text,
    seq: 0,
  })
  // 消息体只放 id 不放正文：总线是路由不是数据库。正文放进去会让流变大，
  // 也会让「库里改了、流里还是旧的」这种不一致有机可乘
  const streamId = await deps.bus.publish(STREAM, { runId: run.id, sessionId: input.sessionId })
  return { runId: run.id, duplicated: false, streamId }
}
