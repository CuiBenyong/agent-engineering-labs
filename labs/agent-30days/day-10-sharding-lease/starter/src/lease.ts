import type { Config } from './index'
import type { LeaseStore } from './infra/index'

export type Logger = (message: string) => void

/** 租约管理器：抢占、续约、放手。租约不是分布式锁——锁是互斥，租约是带过期的所有权。 */
export class LeaseManager {
  /** shard -> 抢到它时拿的 fencing token */
  readonly held = new Map<number, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private lastRenewOkAt = Date.now()
  private frozen = false

  constructor(
    private readonly store: LeaseStore,
    readonly workerId: string,
    private readonly cfg: Config,
    private readonly log: Logger
  ) {}

  /** 租约的值 = 持有者 + 本次抢占拿到的号，两者一起写进同一个 key */
  value(shard: number, token = this.held.get(shard) ?? 0): string {
    return `${this.workerId}|${token}`
  }

  /** 每轮最多抢 acquireBatch 个，慢慢趋于均衡，而不是先启动的人一口气揽下 256 个 */
  async acquire(candidates: number[]): Promise<number[]> {
    const got: number[] = []
    for (const shard of candidates) {
      if (got.length >= this.cfg.acquireBatch) break
      if (this.held.has(shard)) continue
      const token = await this.store.nextFence()
      // 练习 2：真的去抢租约——store.tryAcquire 就是 SET key value NX PX ttl。NX 是「抢占」，
      // PX 是「租约」。现在谁都不问，直接当作抢到了：两个 worker 都会以为 256 个 shard 全归自己。
      const acquired = true
      if (acquired) {
        this.held.set(shard, token)
        got.push(shard)
      }
    }
    return got
  }
  startRenewing(): void {
    this.timer = setInterval(() => void this.renewAll(), this.cfg.renewIntervalMs)
  }

  /** 续约一个 shard。返回 false 不是「重试一下」，是「立刻放手」。 */
  async renewOne(shard: number): Promise<boolean> {
    // 练习 3：把「先 read 再 pexpire」换成一步原子操作。提示：store.renewIfOwner 背后是一段
    // Lua，比较持有者 + 续期在同一次 EVAL 里完成。现在这个版本有两个 bug：不校验牌子上是不是
    // 自己的名字；两步之间的窗口里租约可能到期被人抢走，你的 pexpire 就替对手延长了任期。
    if ((await this.store.read(shard)) === null) return false
    return this.store.pexpire(shard, this.cfg.leaseTtlMs)
  }
  async renewAll(): Promise<void> {
    if (this.frozen) return
    let anyOk = false
    for (const shard of [...this.held.keys()]) {
      if (await this.renewOne(shard)) anyOk = true
      else this.drop(shard, '续约返回 0，牌子已经不是我的了')
    }
    if (anyOk) this.lastRenewOkAt = Date.now()
    // 自杀规则：距上次成功续约超过 TTL 的三分之二就主动全部放手。它把「我以为我还持有」
    // 的窗口从无限压到两个续约周期——最便宜、也最必须有的一条脑裂缓解。
    if (this.held.size > 0 && Date.now() - this.lastRenewOkAt > (this.cfg.leaseTtlMs * 2) / 3) {
      for (const shard of [...this.held.keys()]) this.drop(shard, '连续续约失败，主动放手')
    }
  }
  private drop(shard: number, reason: string): void {
    this.held.delete(shard)
    this.log(`[放手] shard ${shard}：${reason}`)
  }

  /** 模拟 kill -9：停止续约、也不 release。held 里仍记着「我持有」——脑裂由此开始。 */
  freeze(): void {
    this.frozen = true
    if (this.timer) clearInterval(this.timer)
  }

  /** 这里不主动 release，让租约自然到期——主动交还是 D14 优雅停机的内容。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.held.clear()
  }
}
