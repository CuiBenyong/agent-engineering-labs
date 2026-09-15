import { hostname } from 'node:os'
import 'dotenv/config'
import {
  DEMO_SHARDS,
  GROUP,
  PRODUCTION_CONFIG,
  SELFTEST_CONFIG,
  WORKER_REPLICAS,
  appEnv,
  assertProdSafety,
  leaseKey,
  runsStream,
  workersKey,
} from './config'
import { startGateway } from './gateway'
import { type HealthSummary, isAlive } from './heartbeat'
import { createInfra, type Infra } from './infra/index'
import { Worker, installShutdownHooks, sleep } from './worker'

const PORT = Number(process.env.PORT ?? 3014)
const results: boolean[] = []

// 五项自检的标题与失败提示，提示对应 starter 里的四个练习点
const ITEMS: [string, string][] = [
  ['多副本分摊', '消费组没有分摊，或者同一条消息被处理了两次'],
  ['心跳失联检出', 'isAlive 还没实现：距上次心跳超过 staleMs 就该判失联（练习 1）'],
  ['健康检查端点', 'summarizeHealth 还没按存活数汇总（练习 2；需要练习 1 先做完）'],
  ['优雅停机', 'shutdown 还没做「拒新 → 等完 → 交还租约」三步（练习 3）'],
  ['dev/prod 隔离', 'namespaced 没有按 APP_ENV 加前缀，两套环境共用了同一条流（练习 4）'],
]

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/5] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

function logger(id: string): (message: string) => void {
  return (message: string): void => console.log(`  [${id}] ${message}`)
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(10)
  }
  return false
}

async function post(userId: string, message: string, workMs?: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, message, workMs }),
  })
  return ((await res.json()) as { runId: string }).runId
}

/**
 * 常驻服务裸跑不会退出，所以自检在一个进程里起 Gateway 加多个 Worker，
 * 按剧本走完「分摊 → 心跳失联 → 健康检查 → 优雅停机 → 环境隔离」再退出。
 * 时钟按 SELFTEST_CONFIG 等比压缩 20 倍，比例与生产值一致。
 */
async function selfTest(infra: Infra): Promise<number> {
  const cfg = SELFTEST_CONFIG
  const gateway = await startGateway(infra, cfg, PORT)
  // 真实 Redis 上心跳 hash 是持久的，先把上一轮跑完留下的行清掉，免得算进这一轮的存活数
  for (const row of await infra.presence.list(workersKey())) {
    await infra.presence.forget(workersKey(), row.workerId)
  }

  // ---- 1. 多副本分摊：先把 9 条消息投进流，再起 3 个副本一起吃 ----
  const runIds: string[] = []
  for (let i = 1; i <= 9; i += 1) runIds.push(await post(`u-${i}`, `第 ${i} 条消息`))

  const workers = Array.from(
    { length: WORKER_REPLICAS },
    (_, i) => new Worker(`w-${i + 1}`, infra, cfg, logger(`w-${i + 1}`))
  )
  for (const w of workers) w.start()

  const allDone = await waitFor(
    () => workers.reduce((sum, w) => sum + w.handled.length, 0) >= runIds.length,
    5_000
  )
  const per = workers.map((w) => w.handled.length)
  const flat = workers.flatMap((w) => w.handled)
  const ok1 = allDone && per.every((n) => n > 0) && new Set(flat).size === runIds.length
  check(
    1,
    ok1,
    `${workers.map((w) => w.id).join('/')} 各处理 ${per.join('/')} 条，合计 ${flat.length} 条、去重后 ${new Set(flat).size} 条`
  )

  // ---- 2. 心跳：让 w-3 假死（不再打卡也不主动下线），等 3 个上报周期 ----
  workers[2].freezeHeartbeat()
  await sleep(Math.round(cfg.staleMs * 1.4))
  const rows = await infra.presence.list(workersKey())
  const now = Date.now()
  const alive = rows.filter((row) => isAlive(row, now, cfg.staleMs)).map((row) => row.workerId)
  const stale = rows.filter((row) => !isAlive(row, now, cfg.staleMs)).map((row) => row.workerId)
  const ok2 = alive.length === 2 && stale.length === 1 && stale[0] === 'w-3'
  check(
    2,
    ok2,
    `活着 ${alive.join('+') || '(无)'}，失联 ${stale.join('+') || '(无)'}（阈值 ${cfg.staleMs}ms = 3 个上报周期）`
  )

  // ---- 3. 健康检查端点：面板降级，但本实例的就绪探针照旧是绿的 ----
  const panel = (await (
    await fetch(`http://127.0.0.1:${PORT}/admin/workers`)
  ).json()) as HealthSummary
  const health = await fetch(`http://127.0.0.1:${PORT}/healthz`)
  const ok3 =
    panel.status === 'degraded' && panel.alive === 2 && panel.stale === 1 && health.status === 200
  check(
    3,
    ok3,
    `/admin/workers 汇总 ${panel.alive} 活 ${panel.stale} 失联 → ${panel.status}；同时 /healthz 仍是 ${health.status}`
  )

  // ---- 4. 优雅停机：先把另外两个副本下掉，慢任务只留给 w-1 ----
  await workers[1].shutdown()
  await workers[2].shutdown()
  const slowMs = Math.round(cfg.workMs * 8)
  const slowRunId = await post('u-slow', '一次很慢的执行', slowMs)
  await waitFor(() => workers[0].busyCount() === 1, 3_000)
  const ownerBefore = await infra.lease.owner(leaseKey(0))

  installShutdownHooks(workers[0], logger('w-1'), false)
  const startedAt = Date.now()
  process.emit('SIGTERM', 'SIGTERM')
  const lateRunId = await post('u-late', '停机信号之后才到达的新任务')
  await workers[0].shutdown() // 与信号处理函数里的是同一个 promise，等它就是等停机走完
  const elapsed = Date.now() - startedAt

  const slowRun = await infra.store.getRun(slowRunId)
  const lateRun = await infra.store.getRun(lateRunId)
  const ownerAfter = await infra.lease.owner(leaseKey(0))
  const drainedInTime = elapsed >= slowMs / 2 && elapsed < cfg.graceMs

  // 接手方立刻上岗：新副本不必白等一个租约 TTL
  const spare = new Worker('w-4', infra, cfg, logger('w-4'))
  spare.start()
  const handoffAt = Date.now()
  const lateDone = await waitFor(
    async () => (await infra.store.getRun(lateRunId))?.status === 'done',
    3_000
  )
  const handoffMs = Date.now() - handoffAt
  const ownerNow = await infra.lease.owner(leaseKey(0))
  const ok4 =
    slowRun?.status === 'done' &&
    drainedInTime &&
    ownerAfter === null &&
    lateRun?.status === 'pending' &&
    lateDone &&
    ownerNow === 'w-4' &&
    handoffMs < cfg.leaseTtlMs
  check(
    4,
    ok4,
    `手头的 run 收尾成 ${slowRun?.status}（等了 ${elapsed}ms，上限 ${cfg.graceMs}ms），停机后到达的 run 当时仍是 ${lateRun?.status}`
  )
  console.log(
    `      shard 0 的租约：${ownerBefore} → ${ownerAfter ?? '(已交还)'} → ${ownerNow}，接手耗时 ${handoffMs}ms（租约 TTL ${cfg.leaseTtlMs}ms）`
  )

  // ---- 5. dev/prod 隔离：同一个 Redis 里两套流名互不可见 ----
  const devStream = runsStream()
  process.env.APP_ENV = 'prod'
  const prodStream = runsStream()
  await infra.bus.ensureGroup(prodStream, GROUP)
  const prodLenBefore = await infra.bus.len(prodStream)
  await infra.bus.publish(prodStream, { runId: 'run-prod-1', userId: 'u-prod' })
  const prodLenAfter = await infra.bus.len(prodStream)
  process.env.APP_ENV = 'dev'
  // 换一个从没消费过的消费者名去读 dev 流：读到东西就说明 prod 的消息漏进来了
  const leaked = await infra.bus.readGroup(devStream, GROUP, `probe-${Date.now()}`, 10)
  const ok5 = devStream !== prodStream && leaked.length === 0 && prodLenAfter === prodLenBefore + 1
  check(
    5,
    ok5,
    `dev 流 ${devStream}，prod 流 ${prodStream}；往 prod 投 1 条（长度 ${prodLenBefore} → ${prodLenAfter}），dev 侧探针读到 ${leaked.length} 条`
  )

  await spare.shutdown()
  gateway.beginDrain()
  await gateway.app.close()

  const passed = results.filter(Boolean).length
  console.log(`\n=== 自检结束：${passed}/${results.length} 项通过 ===`)
  return passed === results.length ? 0 : 1
}

async function main(): Promise<void> {
  const infra = await createInfra()
  assertProdSafety(infra.mode)
  await infra.store.init()

  if (process.env.SELFTEST === '1') {
    console.log(
      `=== D14 自检开始（基础设施 ${infra.mode}，APP_ENV=${appEnv()}，输入流 ${runsStream()}，演示 ${DEMO_SHARDS} 个分片）===`
    )
    process.exitCode = await selfTest(infra)
    await infra.close()
    return
  }

  // 一个镜像三种角色：ROLE=worker 只跑执行层（compose 的 3 个副本），
  // ROLE=gateway 只跑接入层，不设 ROLE 时两者同进程，方便本机 curl。
  const role = process.env.ROLE ?? 'all'

  if (role === 'worker') {
    // 三个副本共用同一份环境变量，所以副本名默认取容器主机名——它天然每个副本一份。
    // 主机名会随容器重建而变，上一个名字下没 ack 的消息成了孤儿，靠 D9 的 XAUTOCLAIM 兜底。
    const id = process.env.WORKER_ID ?? hostname()
    const log = logger(id)
    const worker = new Worker(id, infra, PRODUCTION_CONFIG, log)
    installShutdownHooks(worker, log)
    worker.start()
    log(
      `已启动：基础设施 ${infra.mode}，输入流 ${runsStream()}，心跳每 ${PRODUCTION_CONFIG.heartbeatMs}ms 一次`
    )
    if (infra.mode === 'memory') {
      log('内存实现是进程内的：要看多副本协作请先 docker compose up -d 并设置 REDIS_URL')
    }
    return
  }

  const gateway = await startGateway(infra, PRODUCTION_CONFIG, PORT)
  const worker =
    role === 'all'
      ? new Worker(process.env.WORKER_ID ?? hostname(), infra, PRODUCTION_CONFIG, logger('worker'))
      : undefined
  worker?.start()
  console.log(
    `Gateway 已监听 ${PORT}（角色 ${role}，基础设施 ${infra.mode}）：就绪探针 /healthz，心跳面板 /admin/workers`
  )

  const stop = (signal: string): void => {
    // Gateway 的优雅停机顺序：先让就绪探针转红，等负载均衡把流量摘走，再关连接。
    // 反过来先关连接的话，那几秒里打进来的请求会直接连接被拒，而不是被换到别的实例。
    console.log(`收到 ${signal}：就绪探针转红，等负载均衡摘掉流量后再关连接`)
    gateway.beginDrain()
    void sleep(PRODUCTION_CONFIG.pollMs)
      .then(() => gateway.app.close())
      .then(() => worker?.shutdown())
      .then(() => infra.close())
      .then(() => process.exit(0))
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
