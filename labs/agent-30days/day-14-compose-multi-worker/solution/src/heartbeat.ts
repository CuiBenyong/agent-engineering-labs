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
 * 判活：距上次心跳超过 staleMs（3 个上报周期）就算失联。
 * 为什么是 3 个周期而不是 1 个：一次 GC 停顿、一次网络抖动都能让一次上报迟到，
 * 阈值取一个周期的话面板会不停地红绿闪烁，值班的人很快就不看它了。
 */
export function isAlive(row: HeartbeatRow, now: number, staleMs: number): boolean {
  return now - row.beatAt <= staleMs
}

/**
 * 汇总：把心跳表变成一张能直接返给运维的面板。
 * 只要有一个副本失联就是 degraded——它不影响正确性（消息还在流里，
 * 没 ack 的会被别人接手），但它意味着容量少了一份，该有人去看一眼。
 */
export function summarizeHealth(rows: HeartbeatRow[], now: number, staleMs: number): HealthSummary {
  const workers: WorkerHealth[] = rows.map((row) => ({
    workerId: row.workerId,
    alive: isAlive(row, now, staleMs),
    lastBeatMs: now - row.beatAt,
    inFlight: row.inFlight,
    version: row.version,
  }))
  const alive = workers.filter((w) => w.alive).length
  return {
    status: alive === workers.length && alive > 0 ? 'ok' : 'degraded',
    total: workers.length,
    alive,
    stale: workers.length - alive,
    workers,
  }
}
