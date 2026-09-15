import type { Bus, BusMessage } from '../infra/bus'
import { DEAD_STREAM, GROUP, POISON_THRESHOLD, STREAM, sleep } from '../shared/config'
import type { Store } from '../shared/store'

export type WorkerDeps = { bus: Bus; store: Store; log: (line: string) => void }
export type PollStats = { handled: number; claimed: number; dead: number; failed: number }
export type PollOpts = { count: number; blockMs: number; minIdleMs: number }

/**
 * 今天的业务处理刻意只做 echo：本章要看清的是总线的语义，不是模型。
 * 把这一个函数换成 D4 的模型调用层，链路的其余部分一行都不用改。
 * 以 boom 开头的输入永远失败——毒消息演示需要一条「换谁来都处理不了」的消息。
 */
async function generateReply(input: string): Promise<string> {
  await sleep(5)
  if (input.trim().toLowerCase().startsWith('boom')) {
    throw new Error('下游处理失败（模拟）：这条消息换谁来处理都会失败')
  }
  return `[echo] ${input}`
}

async function handle(deps: WorkerDeps, consumer: string, msg: BusMessage): Promise<void> {
  const runId = msg.fields.runId ?? ''
  const run = await deps.store.getRun(runId)
  // 孤儿消息：本进程的库里没有这个 run。重投多少次都不会变好，直接销号。
  // 跨进程手动复现时这是预期现象——三张表在 D8 是 Postgres，本天还在进程内存里
  if (!run) {
    deps.log(`[${consumer}] 孤儿消息 ${msg.id}（本进程内存里没有 run=${runId}），直接 XACK`)
    await deps.bus.ack(STREAM, GROUP, [msg.id])
    return
  }
  // at-least-once 的第一道闸门：这条之前已经被完整处理过了（大概率是 XACK 丢了），
  // 直接销号，不重复调模型、不重复扣费
  if (run.status === 'done') {
    deps.log(`[${consumer}] run=${runId} 已是 done，幂等短路，只补一次 XACK`)
    await deps.bus.ack(STREAM, GROUP, [msg.id])
    return
  }

  await deps.store.updateRun(runId, { status: 'running' })
  const reply = await generateReply(run.input)
  // 第二道闸门：unique(run_id, seq)。就算两个 worker 真的同时跑完了同一个 run，
  // 回复也只会落一条，用户不会看到两遍
  const { inserted } = await deps.store.insertMessage({
    sessionId: run.sessionId,
    runId,
    role: 'assistant',
    content: reply,
    seq: 1,
  })
  if (!inserted) deps.log(`[${consumer}] run=${runId} 的回复被 unique(run_id, seq) 挡住了`)
  // 字符数按 1 字符 1 token 粗估（W2 统一口径），D13 会拿这两列去算钱
  await deps.store.updateRun(runId, {
    status: 'done',
    promptTokens: run.input.length,
    completionTokens: reply.length,
  })
  // XACK 必须是最后一步。放到处理之前等于「先销号再干活」，进程一崩这条消息就人间蒸发，
  // 那不是 at-least-once，是 at-most-once
  await deps.bus.ack(STREAM, GROUP, [msg.id])
  deps.log(`[${consumer}] run=${runId} 完成（第 ${msg.deliveryCount} 次投递）→ ${reply}`)
}

/** 处理失败：够不到阈值就什么都不做（留在 pending 等人接手），够了就进死信流 */
async function onFailure(
  deps: WorkerDeps,
  consumer: string,
  msg: BusMessage,
  err: unknown
): Promise<boolean> {
  const reason = err instanceof Error ? err.message : String(err)
  const runId = msg.fields.runId ?? ''
  await deps.store.updateRun(runId, { error: reason })
  // 关键在于**不 XACK**：消息留在 pending 里，等 XAUTOCLAIM 交给下一个空闲 worker
  if (msg.deliveryCount < POISON_THRESHOLD) {
    deps.log(`[${consumer}] run=${runId} 第 ${msg.deliveryCount} 次失败，留在 pending 等重投`)
    return false
  }
  // 投递 3 次仍失败：搬去死信流并 XACK 原流。不搬走它会被无限重投，
  // 把 worker 的处理能力全占住——一条坏消息拖垮整条流
  await deps.bus.publish(DEAD_STREAM, {
    ...msg.fields,
    originalId: msg.id,
    deliveries: String(msg.deliveryCount),
    reason,
  })
  await deps.bus.ack(STREAM, GROUP, [msg.id])
  await deps.store.updateRun(runId, { status: 'failed', error: reason })
  deps.log(`[${consumer}] run=${runId} 投递 ${msg.deliveryCount} 次仍失败 → 搬去 ${DEAD_STREAM}`)
  return true
}

/**
 * 一轮消费。先 XAUTOCLAIM 捡别人掉在地上的，再 XREADGROUP 取新的——
 * 顺序反过来，一条被遗弃的消息会永远排在新消息后面，忙的时候永远轮不到它。
 */
export async function pollOnce(
  deps: WorkerDeps,
  consumer: string,
  opts: PollOpts
): Promise<PollStats> {
  const stats: PollStats = { handled: 0, claimed: 0, dead: 0, failed: 0 }
  const claimed = await deps.bus.autoClaim(STREAM, GROUP, consumer, opts.minIdleMs, opts.count)
  stats.claimed = claimed.length
  for (const m of claimed) {
    deps.log(`[${consumer}] XAUTOCLAIM 接手 ${m.id}（第 ${m.deliveryCount} 次投递）`)
  }
  const fresh =
    claimed.length > 0
      ? []
      : await deps.bus.readGroup(STREAM, GROUP, consumer, opts.count, opts.blockMs)

  for (const msg of [...claimed, ...fresh]) {
    try {
      await handle(deps, consumer, msg)
      stats.handled += 1
    } catch (err) {
      stats.failed += 1
      if (await onFailure(deps, consumer, msg, err)) stats.dead += 1
    }
  }
  return stats
}

/** 常驻循环。优雅停机（跑完手头再退）D14 会补全，今天只做到「不再取新消息」 */
export async function runWorker(
  deps: WorkerDeps,
  consumer: string,
  shouldStop: () => boolean,
  opts: PollOpts
): Promise<void> {
  await deps.bus.ensureGroup(STREAM, GROUP)
  while (!shouldStop()) await pollOnce(deps, consumer, opts)
}
