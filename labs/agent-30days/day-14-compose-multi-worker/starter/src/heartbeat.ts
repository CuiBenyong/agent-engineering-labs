import { APP_VERSION, type Config } from './config'
import type { HeartbeatRow, PresenceStore } from './infra/index'

/** 心跳面板上的一行 */
export interface WorkerHealth {
  workerId: string
  alive: boolean
  lastBeatMs: number
  inFlight: number
  version: string
}

export interface HealthSummary {
  status: 'ok' | 'degraded'
  total: number
  alive: number
  stale: number
  workers: WorkerHealth[]
}

/**
 * 上报侧：worker 每 heartbeatMs 往共享存储写一行「我还活着」。
 * 心跳是 push 而不是 pull——Gateway 不去逐个 ping worker，
 * 因为容器随时换 IP，主动去连的一方需要一份永远在变的名单。
 */
export class HeartbeatReporter {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly workerId: string,
    private readonly presence: PresenceStore,
    private readonly key: string,
    private readonly cfg: Config,
    private readonly inFlight: () => number
  ) {}

  start(): void {
    // 立刻打一次，别让面板空着一个心跳周期才看到新副本上线
    void this.beat()
    this.timer = setInterval(() => void this.beat(), this.cfg.heartbeatMs)
    this.timer.unref()
  }

  async beat(): Promise<void> {
    // 心跳里带上「手头有几个任务」和版本号：光有「活着」只能判死活，
    // 带上这两样才能回答「谁在忙」和「新版本铺了几个副本」。
    await this.presence.beat(this.key, {
      workerId: this.workerId,
      beatAt: Date.now(),
      inFlight: this.inFlight(),
      version: APP_VERSION,
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

/**
 * 练习 1：判活。现在的实现是「谁上报过就算活着」——面板上永远不会出现失联，
 * 一个假死的副本（进程还在、活儿不干了）会一直被算进容量里。
 * 要做的事：拿 now 和 row.beatAt 比，超过 staleMs 就判失联。
 * 提示：阈值是 3 个上报周期而不是 1 个。想清楚为什么不能是 1 个——
 * 一次 GC 停顿就能让一次上报迟到，阈值太紧面板会一直红绿闪烁。
 */
export function isAlive(row: HeartbeatRow, now: number, staleMs: number): boolean {
  void row
  void now
  void staleMs
  return true
}

/**
 * 练习 2：把心跳表汇总成一张能直接返给运维的面板。
 * 现在的实现把每一行都当成活的，所以状态永远是 ok——一个只会说「一切正常」的
 * 健康检查端点比没有更糟，它会让值班的人相信集群是满容量的。
 * 要做的事：用 isAlive 逐行判活，算出 alive / stale，
 * 只要有一个失联就把 status 降成 degraded（一个都没有也算 degraded）。
 * 提示：lastBeatMs 直接写成 now - row.beatAt，面板上「失联 23 秒」比「失联」有用得多。
 */
export function summarizeHealth(rows: HeartbeatRow[], now: number, staleMs: number): HealthSummary {
  void staleMs
  const workers: WorkerHealth[] = rows.map((row) => ({
    workerId: row.workerId,
    alive: true,
    lastBeatMs: 0,
    inFlight: row.inFlight,
    version: row.version,
  }))
  return {
    status: 'ok',
    total: workers.length,
    alive: workers.length,
    stale: 0,
    workers,
  }
}
