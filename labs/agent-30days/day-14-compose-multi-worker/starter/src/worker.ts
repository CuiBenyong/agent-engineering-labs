import { randomUUID } from 'node:crypto'
import { DEMO_SHARDS, GROUP, type Config, leaseKey, runsStream, workersKey } from './config'
import { HeartbeatReporter } from './heartbeat'
import type { BusMessage, Infra } from './infra/index'

export type Logger = (message: string) => void

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 执行层（Worker）的一个副本。compose 里 `--scale worker=3` 起的就是三个这样的进程，
 * 它们靠消费组分摊消息（D9）、靠分片租约保住同用户顺序（D10）。
 * 今天新增的只有两样：周期性心跳上报，以及收到 SIGTERM 之后的优雅停机。
 */
export class Worker {
  /** 处理过的 runId，自检用来验证「每条消息只被一个副本处理」 */
  readonly handled: string[] = []
  private readonly reporter: HeartbeatReporter
  private readonly held = new Set<number>()
  private readonly inFlight = new Set<string>()
  private draining = false
  private stopping: Promise<void> | undefined
  private loop: Promise<void> | undefined
  private renewTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly id: string,
    private readonly infra: Infra,
    readonly cfg: Config,
    private readonly log: Logger
  ) {
    this.reporter = new HeartbeatReporter(id, infra.presence, workersKey(), cfg, () =>
      this.busyCount()
    )
  }

  busyCount(): number {
    return this.inFlight.size
  }
  heldShards(): number[] {
    return [...this.held]
  }

  start(): void {
    this.reporter.start()
    // 租约的抢占与续约来自 D10，本天不改
    this.renewTimer = setInterval(() => void this.renewAll(), this.cfg.renewIntervalMs)
    this.renewTimer.unref()
    this.loop = this.run()
  }

  private async run(): Promise<void> {
    while (!this.draining) {
      try {
        await this.tick()
      } catch (err) {
        this.log(`一轮消费出错，下一轮继续：${String(err)}`)
      }
      if (!this.draining) await sleep(this.cfg.tickMs)
    }
  }

  private async tick(): Promise<void> {
    await this.acquire()
    const msgs = await this.infra.bus.readGroup(runsStream(), GROUP, this.id, this.cfg.readBatch)
    for (const msg of msgs) {
      // 收到停机信号后就不再开新的一条。已经读到手上但还没开始的留在 pending 里，
      // 由 D9 的 XAUTOCLAIM 交给别的副本——那比硬扛完一整批再退出快得多。
      if (this.draining) break
      await this.handle(msg)
    }
  }

  /** 抢自己还没持有的分片租约（D10 的 SET NX + PX） */
  private async acquire(): Promise<void> {
    for (let shard = 0; shard < DEMO_SHARDS; shard += 1) {
      if (this.held.has(shard)) continue
      if (await this.infra.lease.tryAcquire(leaseKey(shard), this.id, this.cfg.leaseTtlMs)) {
        this.held.add(shard)
      }
    }
  }

  private async renewAll(): Promise<void> {
    for (const shard of [...this.held]) {
      const ok = await this.infra.lease.renewIfOwner(leaseKey(shard), this.id, this.cfg.leaseTtlMs)
      // 续约返回 false 不是「重试一下」，是「立刻放手」（D10）
      if (!ok) this.held.delete(shard)
    }
  }

  private async handle(msg: BusMessage): Promise<void> {
    const runId = msg.fields.runId ?? ''
    this.inFlight.add(runId)
    try {
      await this.infra.store.setStatus(runId, 'running')
      // 占位：真实场景这里是一次模型调用（D4 的调用层），耗时不可控，
      // 所以停机时「等手头的跑完」必须有上限，不能无限期地等。
      await sleep(Number(msg.fields.workMs ?? this.cfg.workMs))
      await this.infra.store.setStatus(runId, 'done')
      // 先落库再 XACK：顺序反了，进程崩在中间这条消息就人间蒸发（D9）
      await this.infra.bus.ack(runsStream(), GROUP, [msg.id])
      this.handled.push(runId)
    } finally {
      this.inFlight.delete(runId)
    }
  }

  /**
   * 优雅停机。三步，顺序不能变：
   *  1. 拒绝新任务——把开关拨过去，消费循环下一轮就不再读流；
   *  2. 等手头的任务跑完，但最多等 graceMs（20 秒），超时就放弃等待；
   *  3. 主动交还租约、从心跳面板注销，让接手方立刻上岗，不必白等一个 TTL。
   */
  async shutdown(): Promise<void> {
    // 记住这一次停机的 promise：SIGTERM 连按两下不该启动两次排空，
    // 而第二次调用也应该等到同一次排空结束（自检就靠这个语义等它跑完）。
    this.stopping ??= this.drain()
    return this.stopping
  }

  private async drain(): Promise<void> {
    // 练习 3：优雅停机。现在的实现只是「立刻放手」——手头那次执行停在 running、
    // 租约不交还、心跳也不注销，接手方要白等一个 TTL 才能上岗。三步都要补：
    //   1. 拒绝新任务：这一行已经做了（消费循环下一轮就不再读流）；
    //   2. 等手头的任务跑完，但最多等 this.cfg.graceMs。提示：消费循环里的 await 链
    //      一路通到 handle()，所以「等 this.loop 结束」就等于「等手头的跑完」；
    //      再用 Promise.race 加一个超时，别无限期地等一次卡住的执行。
    //   3. 交还租约（this.infra.lease.releaseIfOwner）并从心跳面板注销
    //      （this.infra.presence.forget）。提示：释放必须带条件——
    //      如果我的租约已经过期、别人刚抢到，无条件删就把对方的牌子一起删了。
    this.draining = true
    this.reporter.stop()
    if (this.renewTimer) clearInterval(this.renewTimer)
  }

  /**
   * 模拟进程假死：不再打卡，但也没有主动下线，租约还挂在自己名下。
   * 这正是心跳要检出的那种死法——进程没退出，所以编排系统看不出问题。
   */
  freezeHeartbeat(): void {
    this.reporter.stop()
  }
}

/**
 * 把停机挂到信号上。容器里 PID 1 收到的是 SIGTERM（D7 讲过为什么要用 exec 形式起进程），
 * exitWhenDone=false 只给自检用：自检要在同一个进程里验证这条链路，不能真的退出。
 */
export function installShutdownHooks(worker: Worker, log: Logger, exitWhenDone = true): void {
  const stop = (signal: string): void => {
    log(`收到 ${signal}：停止取新消息，最多等 ${worker.cfg.graceMs}ms 让手头的任务跑完`)
    void worker.shutdown().then(() => {
      log(`停机流程结束，手头还剩 ${worker.busyCount()} 个任务没跑完，退出`)
      if (exitWhenDone) process.exit(0)
    })
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
}

/** 造一条用户消息：Gateway 的 POST /chat 与自检都走这一条路 */
export function newRun(userId: string, input: string, workMs?: number) {
  const id = randomUUID()
  const fields: Record<string, string> = { runId: id, userId }
  if (workMs !== undefined) fields.workMs = String(workMs)
  return {
    row: { id, sessionId: `s-${userId}`, userId, idempotencyKey: id, input },
    fields,
  }
}
