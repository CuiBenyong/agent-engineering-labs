/**
 * 通知 provider 抽象。这是本课第三次用同一手法（D4 的模型 provider、支付的 PaymentProvider），
 * 但**接口是为通知重新设计的**，不是把支付那份改个名字：
 *   - accepted 不等于 delivered：渠道只承诺"收下了"，真正的送达回执是异步回来的；
 *   - 限流是渠道自带的技术约束（rateLimitPerSec / retryAfterMs），和业务侧的每日上限是两回事；
 *   - 没有 cancel：消息一旦交给渠道就撤不回来，取消只在交出去之前有效。
 */
export type Notification = {
  idempotencyKey: string
  userId: string
  title: string
  body: string
}

export type SendResult =
  | { status: 'accepted'; providerMessageId: string }
  | { status: 'throttled'; retryAfterMs: number }
  | { status: 'rejected'; reason: string; retryable: false }

export interface NotificationProvider {
  readonly id: string
  /** 渠道自己的技术限流，单位：条/秒。业务侧的每日上限不看这个值。 */
  readonly rateLimitPerSec: number
  send(notification: Notification): Promise<SendResult>
  /** 已经真正投出去的消息，用于自检断言"重试没有让用户收到两条"。 */
  inbox(): Notification[]
}

/** 站内信：最简单的渠道，永远收下。 */
class InAppProvider implements NotificationProvider {
  readonly id = 'inapp'
  readonly rateLimitPerSec = 50
  private sent = new Map<string, Notification>()
  async send(notification: Notification): Promise<SendResult> {
    // 幂等键去重：重试到达时返回同一个 providerMessageId，用户不会收到第二条
    this.sent.set(notification.idempotencyKey, notification)
    return { status: 'accepted', providerMessageId: `inapp-${notification.idempotencyKey}` }
  }
  inbox(): Notification[] {
    return [...this.sent.values()]
  }
}

/**
 * 短信：模拟一个真实渠道的两种脾气——首次投递触发限流（429 + Retry-After），
 * 以及对空正文直接拒绝（参数错，不可重试）。
 */
class SmsProvider implements NotificationProvider {
  readonly id = 'sms'
  readonly rateLimitPerSec = 5
  private sent = new Map<string, Notification>()
  private seenOnce = new Set<string>()
  async send(notification: Notification): Promise<SendResult> {
    if (notification.body.trim() === '') {
      return { status: 'rejected', reason: '正文为空', retryable: false }
    }
    if (!this.seenOnce.has(notification.idempotencyKey)) {
      this.seenOnce.add(notification.idempotencyKey)
      return { status: 'throttled', retryAfterMs: 200 }
    }
    this.sent.set(notification.idempotencyKey, notification)
    return { status: 'accepted', providerMessageId: `sms-${notification.idempotencyKey}` }
  }
  inbox(): Notification[] {
    return [...this.sent.values()]
  }
}

export function createProvider(id = process.env.NOTIFY_CHANNEL ?? 'inapp'): NotificationProvider {
  if (id === 'sms') return new SmsProvider()
  if (id === 'inapp') return new InAppProvider()
  throw new Error(`未知通知渠道：${id}（可选 inapp / sms）`)
}

export type DeliverOutcome = { ok: boolean; attempts: number; detail: string }

/** 退避等待。自检把它换成"推进假时钟"，所以重试路径能在一毫秒内验完。 */
export type Sleep = (ms: number) => Promise<void>

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 带重试语义的投递。三类结果的处理方式完全不同：
 *   throttled → 等渠道给的 retryAfterMs 再试，这是它明确告诉你"稍后再来"；
 *   rejected  → 参数错，重试一万次也还是错，直接放弃并把名额还回去；
 *   accepted  → 收下了。重试必须带同一个 idempotencyKey，
 *               否则一次限流就会让用户收到两条一模一样的通知——**发出去的消息撤不回来**。
 */
export async function deliver(
  provider: NotificationProvider,
  notification: Notification,
  sleep: Sleep = realSleep,
  maxAttempts = 3
): Promise<DeliverOutcome> {
  let attempts = 0
  for (;;) {
    attempts += 1
    const result = await provider.send(notification)
    if (result.status === 'accepted') {
      return { ok: true, attempts, detail: result.providerMessageId }
    }
    if (result.status === 'rejected') {
      return { ok: false, attempts, detail: `不可重试：${result.reason}` }
    }
    if (attempts >= maxAttempts) {
      return { ok: false, attempts, detail: `限流且已重试 ${attempts} 次` }
    }
    await sleep(result.retryAfterMs)
  }
}
