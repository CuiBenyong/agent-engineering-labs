// D9 的第一块教学代码：按 provider 分桶的「闸门」。
// 一道闸门 = 一个令牌桶（速率，厂商定的）+ 一个并发信号量（在飞数，你自己定的）+ 一份统计。
// 关键设计：闸门只提供**非阻塞准入**。拿不到许可就让任务回队列去，绝不占着工作槽干等。

export const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 6000)
export const REAL_RATE_WINDOW_MS = 60_000

export type ProviderKind = 'text' | 'image' | 'video' | 'tts'

/**
 * MiniMax 充值用户的 RPM，来自官方速率限制页，不要凭记忆改：
 * 语音 T2A v2 = 20、图像 = 10、视频 v1 = 20、文本 MiniMax-M3 = 200。
 * concurrency 是本课自己定的在飞上限，和 RPM 是两回事：
 * RPM 管「一分钟发几次」，并发管「同一时刻挂着几个」。
 */
export const QUOTA: Record<ProviderKind, { rpm: number; concurrency: number }> = {
  text: { rpm: 200, concurrency: 4 },
  image: { rpm: 10, concurrency: 2 },
  video: { rpm: 20, concurrency: 2 },
  tts: { rpm: 20, concurrency: 3 },
}

/** 令牌桶：每个窗口发 capacity 个令牌。窗口内允许突发，窗口之间不透支。 */
export class TokenBucket {
  private tokens: number
  private windowStart = Date.now()
  private penaltyWindows = 0

  constructor(
    readonly capacity: number,
    readonly windowMs: number = RATE_WINDOW_MS
  ) {
    this.tokens = capacity
  }

  /** 撞到限流之后调用：接下来两个窗口只发一半令牌，主动把压力降下去。 */
  penalize(): void {
    this.penaltyWindows = 2
  }

  private refillIfNeeded(now: number): void {
    if (now - this.windowStart < this.windowMs) return
    const skipped = Math.floor((now - this.windowStart) / this.windowMs)
    this.windowStart += skipped * this.windowMs
    this.tokens =
      this.penaltyWindows > 0 ? Math.max(1, Math.floor(this.capacity / 2)) : this.capacity
    if (this.penaltyWindows > 0) this.penaltyWindows -= 1
  }

  tryTake(): boolean {
    this.refillIfNeeded(Date.now())
    // 练习 1：实现令牌桶的取令牌。窗口内令牌用完就返回 false，
    // 让调度器把任务放回队列去等下一个窗口，而不是在这里干等。
    // 提示：现在这样等于没有限速——跑起来「令牌拦下」永远是 0，
    //       而真实世界里图像接口只有 10 RPM，迟早给你一个 status_code=1002。
    return true
  }

  /** 还要多久才有新令牌——调度器拿它决定下一次重试的时间，而不是死等。 */
  get msUntilRefill(): number {
    return Math.max(0, this.windowStart + this.windowMs - Date.now())
  }
}

/** 最小信号量，只提供非阻塞的 tryAcquire。 */
export class Semaphore {
  private inUse = 0
  constructor(readonly size: number) {}
  get inFlight(): number {
    return this.inUse
  }
  tryAcquire(): (() => void) | null {
    // 练习 2：实现并发上限。在飞数达到 size 就返回 null。
    // 提示：还票函数要防重复调用——长任务的完成回调和失败回调都可能碰到它。
    this.inUse += 1
    return () => {
      this.inUse -= 1
    }
  }
}

export type GateStats = {
  admits: number
  peakInFlight: number
  semBlocks: number
  bucketBlocks: number
  rateLimited: number
  retries: number
}

export class ProviderGate {
  readonly sem: Semaphore
  readonly bucket: TokenBucket
  readonly stats: GateStats = {
    admits: 0,
    peakInFlight: 0,
    semBlocks: 0,
    bucketBlocks: 0,
    rateLimited: 0,
    retries: 0,
  }

  constructor(readonly kind: ProviderKind) {
    this.sem = new Semaphore(QUOTA[kind].concurrency)
    this.bucket = new TokenBucket(QUOTA[kind].rpm)
  }

  /**
   * 非阻塞准入：令牌和并发票都拿到才算通过，返回还票函数；否则返回 null。
   * 注意顺序——先看并发再取令牌，避免「令牌取了却挤不进去」白白浪费一个配额。
   */
  tryAdmit(): (() => void) | null {
    const release = this.sem.tryAcquire()
    if (!release) {
      this.stats.semBlocks += 1
      return null
    }
    if (!this.bucket.tryTake()) {
      release()
      this.stats.bucketBlocks += 1
      return null
    }
    this.stats.admits += 1
    this.stats.peakInFlight = Math.max(this.stats.peakInFlight, this.sem.inFlight)
    return release
  }
}

export type Gates = Record<ProviderKind, ProviderGate>

export function createGates(): Gates {
  return {
    text: new ProviderGate('text'),
    image: new ProviderGate('image'),
    video: new ProviderGate('video'),
    tts: new ProviderGate('tts'),
  }
}

/** 指数退避 + 抖动。抖动是为了避免五集同时醒来、再一起撞一次限流。 */
export function backoffMs(attempt: number): number {
  return Math.round(300 * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6))
}
