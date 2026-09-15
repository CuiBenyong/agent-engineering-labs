import type { Bus } from './infra/index'

/** 可注入的时钟：自检要在一秒内把 15 分钟跑完，不能让读者真等一分钟。 */
export type Clock = { now(): Date }

export const systemClock: Clock = { now: () => new Date() }

export class FakeClock implements Clock {
  private current: Date
  constructor(start: Date) {
    this.current = start
  }
  now(): Date {
    return new Date(this.current)
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}

export type CronTask = { id: string; cron: string; userId: string; input: string }

/** 通用电商客服场景的两个定时任务。生产里这张表通常来自数据库。 */
export const TASKS: CronTask[] = [
  { id: 'daily-digest', cron: '*/5 * * * *', userId: 'u-1', input: '汇总我今天的订单状态' },
  { id: 'unpaid-reminder', cron: '0 9 * * *', userId: 'u-2', input: '提醒我有哪些订单还没付款' },
]

// 只支持三种写法：星号（任意值）、逗号分隔的数字列表、以及「星号斜杠 n」（每隔 n 个单位）
export function matchField(field: string, value: number): boolean {
  if (field === '*') return true
  if (field.startsWith('*/')) {
    const step = Number(field.slice(2))
    return Number.isFinite(step) && step > 0 && value % step === 0
  }
  return field.split(',').some((part) => Number(part) === value)
}

/** cron 五位：分 时 日 月 周。星期用 0 表示周日，和 getUTCDay() 正好一致。 */
export function matches(expr: string, d: Date): boolean {
  const [minute, hour, dom, mon, dow] = expr.split(' ')
  return (
    matchField(minute, d.getUTCMinutes()) &&
    matchField(hour, d.getUTCHours()) &&
    matchField(dom, d.getUTCDate()) &&
    matchField(mon, d.getUTCMonth() + 1) &&
    matchField(dow, d.getUTCDay())
  )
}

/** 把秒和毫秒截掉，得到「计划触发的那一分钟」。 */
export function slotOf(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000)
}

/**
 * 幂等键必须锚在「计划触发的那一分钟」，而不是「我这次醒来的时刻」——
 * 两个调度器实例的醒来时刻永远差几百毫秒，用 Date.now() 拼键会让去重完全失效。
 */
export function buildKey(taskId: string, slot: Date): string {
  return `cron:${taskId}:${slot.toISOString().slice(0, 16)}Z`
}

/** 醒来一次：拿这一分钟去匹配任务表，命中的投递进消息总线。返回投递条数。 */
export async function tick(bus: Bus, clock: Clock, stream: string): Promise<number> {
  const slot = slotOf(clock.now())
  let published = 0
  for (const task of TASKS) {
    if (!matches(task.cron, slot)) continue
    const key = buildKey(task.id, slot)
    await bus.publish(stream, {
      idempotencyKey: key,
      taskId: task.id,
      userId: task.userId,
      input: task.input,
    })
    published += 1
  }
  return published
}
