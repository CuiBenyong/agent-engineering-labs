// D9 实验（solution）：六集同时开机，闸门、令牌桶、优先级与长任务槽位释放全部真跑。
// 一条命令：MOCK=1 pnpm start

import 'dotenv/config'
import { ensureFfmpeg } from './ffmpeg.js'
import { createProviders, isMock } from './providers/index.js'
import { topoSort, type TaskNode } from './dag.js'
import { QUOTA, RATE_WINDOW_MS, REAL_RATE_WINDOW_MS, createGates, type Gates } from './limiter.js'
import { Scheduler, runPool, type Priority, type Task } from './queue.js'
import { buildEpisodeTasks, injectRateLimit } from './jobs.js'
import { warnIfPaidOutputInRepo, Run, newRunId } from './run.js'

/** 工作槽数量：你的进程同时处理几个任务。跟厂商配额无关。 */
const WORKERS = Number(process.env.WORKERS ?? 3)
/** 故障注入。本天支持一个取值：ratelimit —— 让前几次图像与语音调用返回 status_code=1002。 */
const INJECT = process.env.INJECT ?? ''
const T0 = Date.now()

function log(msg: string): void {
  console.log(`  [t+${String(Date.now() - T0).padStart(5)}ms] ${msg}`)
}

function workerLog(worker: string, msg: string): void {
  log(`[${worker}] ${msg}`)
}

async function main() {
  warnIfPaidOutputInRepo()
  await ensureFfmpeg()

  const run = new Run(newRunId())
  await run.init()
  const base = createProviders()
  const providers = INJECT === 'ratelimit' ? injectRateLimit(base, { image: 1, tts: 2 }) : base
  const gates = createGates()

  console.log(`模式：${isMock() ? 'MOCK 离线占位' : `真实厂商 ${providers.video.name}`}`)
  console.log(
    `工作槽 ${WORKERS} 个；速率窗口按 ${RATE_WINDOW_MS}ms 计（真实是 ${REAL_RATE_WINDOW_MS}ms，压缩只为让实验跑得完，配额数字没动）`
  )
  console.log('闸门配置（RPM 来自 MiniMax 官方速率限制页的充值用户档，并发上限是我们自己定的）：')
  for (const [kind, q] of Object.entries(QUOTA))
    console.log(`  ${kind.padEnd(6)} RPM ${String(q.rpm).padStart(3)}   并发上限 ${q.concurrency}`)
  console.log(
    INJECT === 'ratelimit'
      ? '故障注入：ratelimit（前 1 次图像、前 2 次语音会返回 1002）'
      : '故障注入：无（用 INJECT=ratelimit 复现限流与退避）'
  )
  console.log(`产物目录：${run.dir}\n`)

  const deps = { run, providers }
  const plans: [number, Priority][] = [
    [1, 'normal'],
    [2, 'normal'],
    [3, 'low'],
    [4, 'low'],
    [5, 'low'],
  ]
  const tasks = plans.flatMap(([ep, p]) => buildEpisodeTasks(ep, p, deps))

  // 调度之前先用 D8 的拓扑排序确认这张图无环——有环的话下面会永远等下去。
  const asNodes: TaskNode[] = tasks.map((t) => ({
    id: t.id,
    title: t.label,
    deps: t.deps,
    run: async () => ({ artifacts: [] }),
  }))
  console.log(`任务图：${topoSort(asNodes).length} 个节点，无环 ✅\n`)

  const scheduler = new Scheduler(tasks, gates)
  scheduler.holdOpen = 1
  setTimeout(() => {
    log('！！插播急稿：第 6 集要在两小时内上线，按 urgent 入队')
    scheduler.add(buildEpisodeTasks(6, 'urgent', deps))
    scheduler.holdOpen = 0
  }, 1500)

  await runPool(scheduler, WORKERS, gates, workerLog)

  await run.save({ workers: WORKERS, rateWindowMs: RATE_WINDOW_MS })
  report(scheduler, gates, INJECT)
}

function report(scheduler: Scheduler, gates: Gates, inject: string) {
  const rows = Object.values(gates)
  console.log('\n闸门统计：')
  console.log('  provider  准入  峰值在飞/上限  并发拦下  令牌拦下  被限流  重试')
  for (const g of rows) {
    const s = g.stats
    console.log(
      `  ${g.kind.padEnd(9)} ${String(s.admits).padStart(4)}  ${String(s.peakInFlight).padStart(9)}/${QUOTA[g.kind].concurrency}  ${String(s.semBlocks).padStart(8)}  ${String(s.bucketBlocks).padStart(8)}  ${String(s.rateLimited).padStart(6)}  ${String(s.retries).padStart(4)}`
    )
  }

  const byPriority = new Map<Priority, number[]>()
  for (const s of scheduler.stats) {
    const arr = byPriority.get(s.priority) ?? []
    arr.push(s.waitMs)
    byPriority.set(s.priority, arr)
  }
  const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length))
  console.log('\n排队统计（等待 = 入队到被调度）：')
  for (const p of ['urgent', 'normal', 'low'] as Priority[]) {
    const xs = byPriority.get(p) ?? []
    if (xs.length === 0) continue
    console.log(
      `  ${p.padEnd(7)} ${String(xs.length).padStart(3)} 个任务   平均等待 ${String(avg(xs)).padStart(5)}ms   最长 ${String(Math.max(...xs)).padStart(5)}ms`
    )
  }

  const promoted = scheduler.stats.filter((s) => s.promoted > 0)
  const jumps = scheduler.stats
    .filter((s) => s.priority === 'urgent')
    .reduce((a, s) => a + s.jumpedOver, 0)
  console.log(`\n急稿共插到 ${jumps} 个已就绪的低优先级任务前面。`)
  console.log(
    '注意：急稿的平均等待不一定最短——它是在图像配额已经被前五集吃光的时刻插进来的。优先级决定谁先拿到工作槽和下一个令牌，决定不了厂商肯不肯多接一个。'
  )
  const checks: [string, boolean][] = [
    [
      '各 provider 的峰值在飞数都没超过并发上限',
      rows.every((g) => g.stats.peakInFlight <= QUOTA[g.kind].concurrency),
    ],
    ['令牌桶真的挡下过请求（图像的 RPM 是四类里最紧的）', gates.image.stats.bucketBlocks > 0],
    ...(inject === 'ratelimit'
      ? ([
          [
            '注入的限流被识别并退避重试，任务最终成功',
            rows.some((g) => g.stats.rateLimited > 0) && scheduler.failed.length === 0,
          ],
        ] as [string, boolean][])
      : ([
          ['没有任务失败（用 INJECT=ratelimit 复现限流与退避）', scheduler.failed.length === 0],
        ] as [string, boolean][])),
    [`急稿插到了已就绪的低优先级任务前面（本次 ${jumps} 次）`, jumps > 0],
    [`有任务因等待过久被升档（本次 ${promoted.length} 个）`, promoted.length > 0],
    [
      `视频长任务提交后归还了工作槽（本次 ${scheduler.slotReleases} 次）`,
      scheduler.slotReleases > 0,
    ],
  ]
  console.log('\n现象核对：')
  for (const [name, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(`\n失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
