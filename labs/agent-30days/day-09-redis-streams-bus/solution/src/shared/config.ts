/**
 * 本天的固定口径。这些名字和数字在 W2 全周（D9–D14）是同一套。
 * 前缀取自 APP_ENV：dev 与 prod 共用一台 Redis 时靠它隔离流名，D14 部署那天会正式用到。
 */
const prefix = process.env.APP_ENV ? `${process.env.APP_ENV}:` : ''

/** 输入流：Gateway 往这里 XADD，Worker 从这里 XREADGROUP */
export const STREAM = `${prefix}koda:runs`
/** 死信流：反复失败的消息搬到这里，不再占着 pending */
export const DEAD_STREAM = `${prefix}koda:runs:dead`
/** 消费组名。同一个组里的多个 worker 分摊消息，不同组各自收到全量 */
export const GROUP = 'workers'
/** 投递 3 次仍失败 → 死信流。全周固定值 */
export const POISON_THRESHOLD = 3
/** 生产里 XAUTOCLAIM 的空闲阈值要给宽，别把还在正常处理的消息抢走 */
export const CLAIM_MIN_IDLE_MS = Number(process.env.CLAIM_MIN_IDLE_MS ?? 30_000)
/** MOCK=1 强制走内存实现：零外部服务，不需要 Redis、不需要 Docker、不需要 API key */
export const REDIS_URL = process.env.MOCK === '1' ? undefined : process.env.REDIS_URL

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
