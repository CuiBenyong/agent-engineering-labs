/**
 * 可注入时钟。本天的三道闸全都依赖"现在几点"，如果只能读系统时间，
 * 时区、安静时段、跨午夜这些分支就没法在一秒内验完——自检会退化成"看着不报错"。
 */
export type Clock = { now(): Date }

export const systemClock: Clock = { now: () => new Date() }

export class FakeClock implements Clock {
  private current: Date
  constructor(start: Date | string) {
    this.current = new Date(start)
  }
  now(): Date {
    return new Date(this.current)
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
  set(at: Date | string): void {
    this.current = new Date(at)
  }
}
