// 本周固定口径集中在这一个文件里：正文、compose、自检都从这里引用，
// 改数只改这里，不会出现「代码里 5 秒、文档里 10 秒」这种对不上的情况。

/** worker 每 5 秒上报一次心跳 */
export const HEARTBEAT_INTERVAL_MS = 5_000
/** 连续 3 个周期（15 秒）没上报就判失联 */
export const HEARTBEAT_STALE_MS = 15_000
/** 收到 SIGTERM 之后最多等 20 秒，超时就放弃等待 */
export const SHUTDOWN_GRACE_MS = 20_000
/** compose 里的 worker 副本数 */
export const WORKER_REPLICAS = 3
/** D9 定的消费组名，本天不改 */
export const GROUP = 'workers'
/** D10 定的固定分片数，本天不改；自检只演示前 DEMO_SHARDS 个，免得打印 256 行 */
export const SHARD_COUNT = 256
export const DEMO_SHARDS = 3
/** 心跳里带上版本号：滚动发布时能一眼看出新旧两批副本各剩几个 */
export const APP_VERSION = process.env.APP_VERSION ?? 'v1'

export interface Config {
  heartbeatMs: number
  staleMs: number
  graceMs: number
  leaseTtlMs: number
  renewIntervalMs: number
  tickMs: number
  pollMs: number
  workMs: number
  readBatch: number
}

export const PRODUCTION_CONFIG: Config = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  staleMs: HEARTBEAT_STALE_MS,
  graceMs: SHUTDOWN_GRACE_MS,
  leaseTtlMs: 30_000, // D10 定的租约 TTL
  renewIntervalMs: 10_000, // D10 定的续约间隔（TTL 的三分之一）
  tickMs: 500,
  pollMs: 200,
  workMs: 800, // 一次执行的耗时占位；真实场景这里是一次模型调用
  readBatch: 4,
}

/**
 * 自检把整个时钟等比压缩 20 倍：5/15/20 秒变成 250/750/1000 毫秒，
 * 比例关系与生产值完全一致，否则跑一遍要等一分多钟。
 */
export const SELFTEST_CONFIG: Config = {
  heartbeatMs: 250,
  staleMs: 750,
  graceMs: 1_000,
  leaseTtlMs: 1_500,
  renewIntervalMs: 500,
  tickMs: 50,
  pollMs: 20,
  workMs: 40,
  readBatch: 4,
}

export type AppEnv = 'dev' | 'prod'

/** 只认 dev 和 prod 两个值：拼错成 development 时立刻报错，而不是静默变成第三套环境 */
export function appEnv(): AppEnv {
  const raw = process.env.APP_ENV ?? 'dev'
  if (raw !== 'dev' && raw !== 'prod') {
    throw new Error(`APP_ENV 只能是 dev 或 prod，收到的是 ${raw}`)
  }
  return raw
}

/**
 * 所有 Redis 键名都必须过这一层。前缀只在这一个函数里拼，
 * 散落在各处拼字符串的话，漏掉一处就等于本机调试的消息被线上 worker 捞走执行。
 */
export function namespaced(name: string): string {
  return `${appEnv()}:${name}`
}

/** D9 定的输入流名，加上环境前缀 */
export function runsStream(): string {
  return namespaced('koda:runs')
}

/** 心跳面板：一个 hash，字段名是 workerId */
export function workersKey(): string {
  return namespaced('koda:workers')
}

/** D10 定的租约键名，加上环境前缀 */
export function leaseKey(shard: number): string {
  return namespaced(`lease:shard:${shard}`)
}

/**
 * 生产环境禁止跑内存实现。少了这一句，一次配置疏漏（忘了给容器注入 REDIS_URL）
 * 会让线上进程安静地起来、各自在自己的内存里干活，而且所有健康检查都是绿的。
 */
export function assertProdSafety(mode: 'memory' | 'real'): void {
  if (appEnv() === 'prod' && mode !== 'real') {
    throw new Error('APP_ENV=prod 却没有 REDIS_URL / DATABASE_URL：生产环境不允许跑内存实现')
  }
}
