import type { Config } from './index'
import type { Delivered, Infra } from './infra/index'
import { LeaseManager, type Logger } from './lease'
import { SHARD_COUNT, scanOrder } from './shard'

export type WriteRecord = {
  userId: string
  seq: number
  text: string
  worker: string
  fence: number
}

/** D8 那张 messages 表的占位实现，只保留带 fencing token（护栏令牌）的条件写入。 */
export class MessageStore {
  private readonly rows: WriteRecord[] = []
  private readonly highest = new Map<string, number>()

  // 只接受「号不比见过的最大号小」的写入。前任持牌人从 GC 停顿里醒过来时手上是旧号，
  // 写入会被直接拒绝——哪怕它自己还真诚地以为自己持有那个 shard。真实 SQL 是一句条件更新。
  async write(row: WriteRecord): Promise<boolean> {
    if (row.fence < (this.highest.get(row.userId) ?? 0)) return false
    this.highest.set(row.userId, row.fence)
    this.rows.push(row)
    return true
  }
  of(userId: string): WriteRecord[] {
    return this.rows.filter((r) => r.userId === userId)
  }
}

/**
 * 一个 worker：抢一批 shard，只消费自己持有的。同用户顺序的三层保证：一个 shard 只有一个
 * 持有者（LeaseManager）、shard 内逐条串行（drain 的 for+await）、前任在途的那条先 claim 回来。
 */
export class ShardWorker {
  readonly lease: LeaseManager
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly chains = new Map<number, Promise<void>>()
  private stopped = false

  constructor(
    readonly id: string,
    private readonly infra: Infra,
    private readonly sink: MessageStore,
    private readonly cfg: Config,
    private readonly log: Logger
  ) {
    this.lease = new LeaseManager(infra.lease, id, cfg, log)
  }
  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.tickMs)
    this.lease.startRenewing()
  }
  private async tick(): Promise<void> {
    if (this.stopped) return
    await this.lease.acquire(scanOrder(this.id, SHARD_COUNT))
    // 并行的单位是 shard，不是消息：每个持有的 shard 一条独立处理链，互不阻塞。
    for (const shard of this.lease.held.keys()) {
      if (this.chains.has(shard)) continue
      this.chains.set(
        shard,
        this.drain(shard).finally(() => this.chains.delete(shard))
      )
    }
  }
  private async drain(shard: number): Promise<void> {
    const n = this.cfg.readBatch
    const msgs = await this.infra.bus.consume(shard, this.id, n, this.cfg.reclaimIdleMs)
    // 逐条 await。改成 Promise.all 吞吐会上去，同一个用户的顺序会当场丢掉——
    // 而顺序才是今天所有机制存在的理由。
    for (const d of msgs) await this.handle(shard, d)
  }
  private async handle(shard: number, d: Delivered): Promise<void> {
    // 放手之后不许再写：租约丢了就意味着这个用户现在归别人管。
    const fence = this.lease.held.get(shard)
    if (fence === undefined) return
    // 处理一条消息的耗时是不确定的（真实场景里这里是一次模型调用），所以顺序不能靠「碰巧」
    await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 8)))
    const text = `已处理：${d.msg.text}`
    const ok = await this.sink.write({ ...d.msg, text, worker: this.id, fence })
    if (!ok) {
      this.log(`[被护栏拒绝] 旧号 ${fence} 想写 ${d.msg.userId} 的第 ${d.msg.seq} 条`)
      return
    }
    await this.infra.bus.ack(shard, [d.id])
  }

  /** 模拟被 kill -9：停 tick、停续约、不 release、内存里仍记着自己持有。 */
  freeze(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.lease.freeze()
  }
  async shutdown(): Promise<void> {
    this.freeze()
    await Promise.all([...this.chains.values()])
    this.lease.stop()
  }
}
