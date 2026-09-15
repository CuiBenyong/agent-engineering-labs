import { REDIS_URL } from '../shared/config'
import { createMemoryBus } from './memory-bus'
import { createRedisBus } from './redis-bus'

export interface BusMessage {
  /** Redis 生成的 id，形如 1757000000000-0：毫秒时间戳 + 同毫秒内的序号 */
  id: string
  fields: Record<string, string>
  /** 被投递过几次。Redis 的 PEL 自己在记，毒消息判定直接读它，不用另建计数表 */
  deliveryCount: number
}

/** 消息总线的端口。前四个方法一一对应 Redis 的四个核心命令，后三个是为了能观察和收尾 */
export interface Bus {
  /** XGROUP CREATE ... MKSTREAM，组已存在时静默通过 */
  ensureGroup(stream: string, group: string): Promise<void>
  /** XADD */
  publish(stream: string, fields: Record<string, string>): Promise<string>
  /** XREADGROUP：只取从未投递给本组的新消息 */
  readGroup(
    s: string,
    g: string,
    consumer: string,
    count: number,
    blockMs: number
  ): Promise<BusMessage[]>
  /** XACK：把消息从 pending 里销号 */
  ack(stream: string, group: string, ids: string[]): Promise<number>
  /** XAUTOCLAIM：把闲置超过 minIdleMs 的 pending 消息改判给 consumer */
  autoClaim(
    s: string,
    g: string,
    consumer: string,
    minIdleMs: number,
    count: number
  ): Promise<BusMessage[]>
  /** XPENDING 汇总：这个组还有多少条「已投递未确认」 */
  pendingCount(stream: string, group: string): Promise<number>
  /** XLEN */
  length(stream: string): Promise<number>
  /** DEL：只有自检会用它，把上一轮跑剩下的流清干净 */
  reset(streams: string[]): Promise<void>
  close(): Promise<void>
}

/** 唯一的选择点。接口之下两个实现，gateway 与 worker 的业务代码只写一遍 */
export function createBus(): Bus {
  return REDIS_URL ? createRedisBus(REDIS_URL) : createMemoryBus()
}
