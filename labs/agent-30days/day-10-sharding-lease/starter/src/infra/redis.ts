// 真实实现：ioredis 5.x + EVAL 跑 Lua。docker compose up -d 之后
// REDIS_URL=redis://127.0.0.1:6510 pnpm start:worker，跑的是同一份业务代码。
import Redis from 'ioredis'

import type { Bus, Delivered, InboundMessage, Infra, LeaseStore } from './index'

const key = (shard: number): string => `lease:shard:${shard}`
const stream = (shard: number): string => `koda:runs:s${shard}`
const GROUP = 'workers'

/** 续约：比较持有者 + 续期在同一次 EVAL 里完成，中间插不进别人。 */
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

class RedisLeaseStore implements LeaseStore {
  constructor(private readonly r: Redis) {}
  async nextFence() {
    return this.r.incr('lease:fence')
  }
  async tryAcquire(shard: number, value: string, ttlMs: number) {
    // NX 是「抢占」，PX 是「租约」。少了 NX 就是覆盖别人，少了 PX 就是永不失效的死锁。
    return (await this.r.set(key(shard), value, 'PX', ttlMs, 'NX')) === 'OK'
  }
  async read(shard: number) {
    return this.r.get(key(shard))
  }
  async pexpire(shard: number, ttlMs: number) {
    return (await this.r.pexpire(key(shard), ttlMs)) === 1
  }
  async renewIfOwner(shard: number, value: string, ttlMs: number) {
    return (await this.r.eval(RENEW_LUA, 1, key(shard), value, String(ttlMs))) === 1
  }
}

type RawEntry = [string, string[]]

class RedisBus implements Bus {
  private readonly ready = new Set<number>()
  constructor(private readonly r: Redis) {}

  /** 用 call() 直发命令，参数顺序和 redis-cli 里敲的一模一样，方便对照官方文档。 */
  private async send<T>(cmd: string, args: (string | number)[]): Promise<T> {
    return (await this.r.call(cmd, ...args.map(String))) as T
  }

  private async ensureGroup(shard: number): Promise<void> {
    if (this.ready.has(shard)) return
    // BUSYGROUP 表示消费组已存在，是正常情况
    await this.r.xgroup('CREATE', stream(shard), GROUP, '0', 'MKSTREAM').catch(() => undefined)
    this.ready.add(shard)
  }

  async publish(shard: number, msg: InboundMessage): Promise<void> {
    await this.ensureGroup(shard)
    const f = ['userId', msg.userId, 'seq', String(msg.seq), 'text', msg.text]
    await this.r.xadd(stream(shard), '*', ...f)
  }

  async consume(shard: number, consumer: string, n: number, idleMs: number) {
    await this.ensureGroup(shard)
    const s = stream(shard)
    // 先 claim 前任领走没做完的，再读新的。反过来的话新消息会插到旧消息前面。
    const claim = [s, GROUP, consumer, idleMs, '0', 'COUNT', n]
    const claimed = await this.send<[string, RawEntry[], string[]]>('XAUTOCLAIM', claim)
    const out = claimed[1].map(toDelivered)
    if (out.length >= n) return out
    const args = ['GROUP', GROUP, consumer, 'COUNT', n - out.length, 'STREAMS', s, '>']
    const fresh = await this.send<[string, RawEntry[]][] | null>('XREADGROUP', args)
    for (const [, entries] of fresh ?? []) out.push(...entries.map(toDelivered))
    return out
  }

  async ack(shard: number, ids: string[]): Promise<void> {
    if (ids.length > 0) await this.r.xack(stream(shard), GROUP, ...ids)
  }
  async close(): Promise<void> {
    await this.r.quit()
  }
}

function toDelivered([id, f]: RawEntry): Delivered {
  const m = new Map<string, string>()
  for (let i = 0; i + 1 < f.length; i += 2) m.set(f[i], f[i + 1])
  const seq = Number(m.get('seq') ?? 0)
  return { id, msg: { userId: m.get('userId') ?? '', seq, text: m.get('text') ?? '' } }
}

export function createRedisInfra(url: string): Infra {
  const r = new Redis(url)
  return { kind: 'redis', lease: new RedisLeaseStore(r), bus: new RedisBus(r) }
}
