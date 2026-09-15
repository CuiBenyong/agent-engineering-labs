import Redis from 'ioredis'

export interface BusMessage {
  id: string
  fields: Record<string, string>
}

/**
 * 消息总线端口。两种实现：内存版（MOCK=1，零外部服务）与 Redis 版（设了 REDIS_URL）。
 * 业务代码只认这个接口，所以 worker 的消费循环、gateway 的读流循环在两种模式下是同一份代码。
 * 除了流，这里还带了三个 flag 方法——它们对应 Redis 的普通键，用来放「需要重跑」这类瞬态信号。
 */
export interface Bus {
  ensureGroup(stream: string, group: string): Promise<void>
  publish(stream: string, fields: Record<string, string>): Promise<string>
  readGroup(stream: string, group: string, consumer: string, count: number): Promise<BusMessage[]>
  ack(stream: string, group: string, ids: string[]): Promise<void>
  /** XREAD 语义：读 fromId 之后的消息，不占用消费组（gateway 是旁观者，不消费） */
  read(stream: string, fromId: string, count: number): Promise<BusMessage[]>
  flagSet(key: string, ttlMs: number): Promise<void>
  flagGet(key: string): Promise<boolean>
  flagClear(key: string): Promise<void>
  close(): Promise<void>
}

const seqOf = (id: string): number => Number(id.split('-')[0])

/** 内存版：用数组和 Map 把 Redis Streams 的语义写出来，不是打桩。 */
class MemoryBus implements Bus {
  private readonly streams = new Map<string, BusMessage[]>()
  private readonly cursors = new Map<string, number>()
  private readonly flags = new Map<string, number>()
  private counter = 0

  private entries(stream: string): BusMessage[] {
    const existing = this.streams.get(stream)
    if (existing) return existing
    const created: BusMessage[] = []
    this.streams.set(stream, created)
    return created
  }

  async ensureGroup(stream: string, group: string): Promise<void> {
    const key = `${stream} ${group}`
    if (!this.cursors.has(key)) this.cursors.set(key, 0)
  }

  async publish(stream: string, fields: Record<string, string>): Promise<string> {
    this.counter += 1
    const id = `${this.counter}-0`
    this.entries(stream).push({ id, fields })
    return id
  }

  async readGroup(
    stream: string,
    group: string,
    _consumer: string,
    count: number
  ): Promise<BusMessage[]> {
    const key = `${stream} ${group}`
    const cursor = this.cursors.get(key) ?? 0
    const batch = this.entries(stream).slice(cursor, cursor + count)
    // 消费组的语义：读过就前移游标，同一条消息不会同时发给两个消费者。
    // 真实 Redis 还会把它挂进 pending 列表、等 XACK 才销记录（D9 讲透了），
    // 本天用不到重投递，所以这里只保留游标这一半。
    this.cursors.set(key, cursor + batch.length)
    return batch
  }

  async ack(): Promise<void> {
    // 内存版没有 pending 列表，ack 是空操作（D9 的 lab 里它不是）
  }

  async read(stream: string, fromId: string, count: number): Promise<BusMessage[]> {
    const from = fromId === '0' ? 0 : seqOf(fromId)
    // 线性扫描：真实实现是按 id 有序的跳表，这里为了看清楚用全量过滤
    return this.entries(stream)
      .filter((m) => seqOf(m.id) > from)
      .slice(0, count)
  }

  async flagSet(key: string, ttlMs: number): Promise<void> {
    this.flags.set(key, Date.now() + ttlMs)
  }

  async flagGet(key: string): Promise<boolean> {
    const until = this.flags.get(key)
    if (until === undefined) return false
    if (until < Date.now()) {
      this.flags.delete(key)
      return false
    }
    return true
  }

  async flagClear(key: string): Promise<void> {
    this.flags.delete(key)
  }

  async close(): Promise<void> {
    this.streams.clear()
  }
}

/** ioredis 的 XREAD / XREADGROUP 返回的是嵌套数组，先把它归一成 BusMessage[] */
function parseStreams(raw: unknown): BusMessage[] {
  if (!Array.isArray(raw)) return []
  const out: BusMessage[] = []
  for (const perStream of raw as [string, [string, string[]][]][]) {
    for (const [id, flat] of perStream[1] ?? []) {
      const fields: Record<string, string> = {}
      for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1]
      out.push({ id, fields })
    }
  }
  return out
}

/** 真实版：同一份业务代码，换掉的只有这个类。 */
class RedisBus implements Bus {
  private readonly redis: Redis

  constructor(url: string) {
    this.redis = new Redis(url)
  }

  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
    } catch {
      // BUSYGROUP：已经建过了，这是正常路径而不是错误
    }
  }

  async publish(stream: string, fields: Record<string, string>): Promise<string> {
    const flat = Object.entries(fields).flat()
    const id = await this.redis.xadd(stream, '*', ...flat)
    return id ?? ''
  }

  async readGroup(
    stream: string,
    group: string,
    consumer: string,
    count: number
  ): Promise<BusMessage[]> {
    const raw = await this.redis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      count,
      'STREAMS',
      stream,
      '>'
    )
    return parseStreams(raw)
  }

  async ack(stream: string, group: string, ids: string[]): Promise<void> {
    if (ids.length > 0) await this.redis.xack(stream, group, ...ids)
  }

  async read(stream: string, fromId: string, count: number): Promise<BusMessage[]> {
    // 这里用非阻塞 XREAD 配短轮询，好让内存版与真实版共用同一个循环；
    // 生产里应该带 BLOCK 参数，把空轮询交给 Redis 去等。
    const raw = await this.redis.xread('COUNT', count, 'STREAMS', stream, fromId)
    return parseStreams(raw)
  }

  async flagSet(key: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, '1', 'PX', ttlMs)
  }

  async flagGet(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1
  }

  async flagClear(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async close(): Promise<void> {
    await this.redis.quit()
  }
}

/** 唯一的选择点：设了 REDIS_URL 就连真 Redis，否则用内存实现。 */
export function createBus(): Bus {
  const url = process.env.REDIS_URL
  if (url) {
    console.log(`[infra] Bus = Redis(${url})`)
    return new RedisBus(url)
  }
  console.log('[infra] Bus = 内存实现（未设置 REDIS_URL）')
  return new MemoryBus()
}
