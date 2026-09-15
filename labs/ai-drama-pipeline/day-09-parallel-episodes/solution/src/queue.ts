// D9 的第二块教学代码：带优先级、防饿死、且「任何等待都不占工作槽」的调度器。
// 它和 D8 的任务图是两件事：D8 决定谁依赖谁，D9 决定谁先上、能上几个、上不去时怎么办。

import { MiniMaxError } from './providers/index.js'
import { backoffMs, type Gates, type ProviderKind } from './limiter.js'

export type Priority = 'urgent' | 'normal' | 'low'

const RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 }

/** 等这么久还没被调度就升一档。最省事也最有效的防饿死手段。 */
export const AGING_MS = Number(process.env.AGING_MS ?? 1200)
export const MAX_ATTEMPTS = 5

/**
 * start() 返回 undefined 表示任务在返回时就做完了；
 * 返回一个函数表示「已经交给厂商了，接下来只是等」——工作槽立刻释放，
 * 闸门的票继续held 到等待结束。视频就是这一类。
 */
export type Task = {
  id: string
  episode: string
  label: string
  priority: Priority
  deps: string[]
  /** 这一步要走哪道闸门；不调用 provider 的步骤（比如算时间轴）留空。 */
  gate?: ProviderKind
  attempt: number
  start: () => Promise<(() => Promise<void>) | undefined>
}

export type TaskStat = {
  id: string
  priority: Priority
  waitMs: number
  promoted: number
  jumpedOver: number
}

export class Scheduler {
  private readonly pending = new Map<string, Task>()
  private readonly enqueuedAt = new Map<string, number>()
  private readonly notBefore = new Map<string, number>()
  private readonly promoted = new Map<string, number>()
  private readonly admissions = new Map<string, () => void>()
  private readonly done = new Set<string>()
  private readonly wakers: (() => void)[] = []
  private running = 0
  /** 大于 0 表示后面还会有任务插进来，此时即使队列空了也不许工作槽退出。 */
  holdOpen = 0
  readonly stats: TaskStat[] = []
  readonly failed: { id: string; message: string }[] = []
  readonly skipped: string[] = []
  /** 长任务提交后归还工作槽的次数，用来证明槽位真的被放开了。 */
  slotReleases = 0
  /** 因为闸门不放行而被跳过的次数——这个数字大就说明你的配额是瓶颈，不是你的代码慢。 */
  quotaSkips = 0

  constructor(
    tasks: Task[],
    private readonly gates: Gates
  ) {
    this.add(tasks)
  }

  get finished(): boolean {
    return this.pending.size === 0 && this.running === 0 && this.holdOpen === 0
  }

  /** 没人在跑、也没东西能跑：剩下的任务等的是失败的上游，永远等不到。 */
  get deadlocked(): boolean {
    return (
      this.running === 0 && this.holdOpen === 0 && this.pending.size > 0 && !this.hasDispatchable()
    )
  }

  add(tasks: Task[]): void {
    const now = Date.now()
    for (const t of tasks) {
      this.pending.set(t.id, t)
      this.enqueuedAt.set(t.id, now)
      this.promoted.set(t.id, 0)
    }
    this.wakeAll()
  }

  private wakeAll(): void {
    while (this.wakers.length > 0) this.wakers.shift()?.()
  }

  private ready(t: Task, now: number): boolean {
    if ((this.notBefore.get(t.id) ?? 0) > now) return false
    return t.deps.every((d) => this.done.has(d))
  }

  private hasDispatchable(): boolean {
    const now = Date.now()
    for (const t of this.pending.values()) if (this.ready(t, now)) return true
    return false
  }

  /**
   * 有效优先级 = 原始档位 - 升过的档数。
   * 关键约束：老化最多升到 normal，**不许升进 urgent 车道**——
   * 否则跑上几分钟之后所有任务都是急稿，这一档就名存实亡。
   */
  private effectiveRank(t: Task): number {
    return RANK[t.priority] - (this.promoted.get(t.id) ?? 0)
  }

  private ageAll(onLog: (msg: string) => void): void {
    const now = Date.now()
    for (const t of this.pending.values()) {
      const waited = now - (this.enqueuedAt.get(t.id) ?? now)
      // 升档上限是 RANK - RANK.normal：low 最多升到 normal，urgent / normal 本来就升无可升。
      const want = Math.max(
        0,
        Math.min(RANK[t.priority] - RANK.normal, Math.floor(waited / AGING_MS))
      )
      if (want > (this.promoted.get(t.id) ?? 0)) {
        this.promoted.set(t.id, want)
        onLog(`饿死保护：${t.id} 等了 ${waited}ms，优先级升 ${want} 档`)
      }
    }
  }

  /**
   * 取一个可以真正开工的任务：依赖满足、退避时间到了、并且它那道闸门肯放行。
   * 闸门不放行时**跳过它去看下一个**，而不是让工作槽在这儿干等——
   * 这一条是本实验的重点，也是优先级能起作用的前提。
   */
  take(onLog: (msg: string) => void): Task | undefined {
    this.ageAll(onLog)
    const now = Date.now()
    const candidates = [...this.pending.values()]
      .filter((t) => this.ready(t, now))
      .sort(
        (a, b) =>
          this.effectiveRank(a) - this.effectiveRank(b) ||
          (this.enqueuedAt.get(a.id) ?? 0) - (this.enqueuedAt.get(b.id) ?? 0)
      )

    for (const [i, task] of candidates.entries()) {
      if (task.gate) {
        const release = this.gates[task.gate].tryAdmit()
        if (!release) {
          this.quotaSkips += 1
          continue
        }
        this.admissions.set(task.id, release)
      }
      const rank = this.effectiveRank(task)
      const jumpedOver = candidates.filter((t, j) => j !== i && this.effectiveRank(t) > rank).length
      this.pending.delete(task.id)
      this.running += 1
      this.stats.push({
        id: task.id,
        priority: task.priority,
        waitMs: now - (this.enqueuedAt.get(task.id) ?? now),
        promoted: this.promoted.get(task.id) ?? 0,
        jumpedOver,
      })
      return task
    }
    return undefined
  }

  /** 闸门的票在真正调用结束后才还——长任务在后台等待期间，票是一直占着的。 */
  releaseAdmission(taskId: string): void {
    this.admissions.get(taskId)?.()
    this.admissions.delete(taskId)
  }

  complete(task: Task): void {
    this.releaseAdmission(task.id)
    this.done.add(task.id)
    this.running -= 1
    this.wakeAll()
  }

  /** 退避 = 还票 + 重新入队 + 记一个「不早于」时间戳。整个过程不占工作槽。 */
  requeue(task: Task, delayMs: number): void {
    this.releaseAdmission(task.id)
    task.attempt += 1
    this.pending.set(task.id, task)
    this.notBefore.set(task.id, Date.now() + delayMs)
    this.running -= 1
    this.wakeAll()
  }

  fail(task: Task, err: unknown): void {
    this.releaseAdmission(task.id)
    this.failed.push({ id: task.id, message: err instanceof Error ? err.message : String(err) })
    this.running -= 1
    // 失败的节点不进 done，它的下游会一直等不到依赖——这就是「失败半径」的直观演示。
    this.wakeAll()
  }

  /** 把等不到依赖的任务一次性作废，避免工作槽空转。 */
  drainStuck(): string[] {
    const ids = [...this.pending.keys()]
    this.pending.clear()
    this.skipped.push(...ids)
    this.wakeAll()
    return ids
  }

  async waitForChange(): Promise<void> {
    if (this.finished) return
    await Promise.race([
      new Promise<void>((r) => this.wakers.push(r)),
      new Promise<void>((r) => setTimeout(r, 50)),
    ])
  }
}

/**
 * 工作槽池。size 是「你的进程同时处理几个任务」，跟厂商配额不是一回事：
 * 闸门管厂商那边同时挂着几个请求，工作槽管你自己这边有几条执行流。
 */
export async function runPool(
  scheduler: Scheduler,
  size: number,
  gates: Gates,
  log: (worker: string, msg: string) => void
): Promise<void> {
  const background: Promise<void>[] = []

  const onError = (name: string, task: Task, err: unknown): void => {
    const rateLimited = err instanceof MiniMaxError && err.kind === 'rate-limited'
    if (rateLimited && task.gate) {
      gates[task.gate].stats.rateLimited += 1
      gates[task.gate].bucket.penalize()
    }
    const retryable = err instanceof MiniMaxError ? err.retryable : false
    if (retryable && task.attempt + 1 < MAX_ATTEMPTS) {
      const delay = backoffMs(task.attempt + 1)
      if (task.gate) gates[task.gate].stats.retries += 1
      log(name, `${task.id} 撞上限流（第 ${task.attempt + 1} 次），退避 ${delay}ms 后重新入队`)
      scheduler.requeue(task, delay)
      return
    }
    log(name, `失败 ${task.id}：${err instanceof Error ? err.message : String(err)}`)
    scheduler.fail(task, err)
  }

  const worker = async (name: string): Promise<void> => {
    for (;;) {
      if (scheduler.finished) return
      const task = scheduler.take((m) => log(name, m))
      if (!task) {
        if (scheduler.deadlocked) {
          const stuck = scheduler.drainStuck()
          if (stuck.length > 0)
            log(name, `上游失败，跳过 ${stuck.length} 个下游任务：${stuck.join(', ')}`)
          continue
        }
        await scheduler.waitForChange()
        continue
      }
      log(name, `开始 ${task.id}（${task.label}，${task.priority}）`)
      try {
        const pending = await task.start()
        if (!pending) {
          log(name, `完成 ${task.id}`)
          scheduler.complete(task)
          continue
        }
        // 长任务：厂商那边还在跑，闸门的票继续占着，但我这条执行流没必要陪着等。
        scheduler.slotReleases += 1
        log(name, `${task.id} 已提交给厂商，释放工作槽去接别的活`)
        background.push(
          pending()
            .then(() => {
              log(name, `完成 ${task.id}（后台等待结束）`)
              scheduler.complete(task)
            })
            .catch((err: unknown) => onError(name, task, err))
        )
      } catch (err: unknown) {
        onError(name, task, err)
      }
    }
  }

  await Promise.all(Array.from({ length: size }, (_, i) => worker(`W${i + 1}`)))
  await Promise.allSettled(background)
}
