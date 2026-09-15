import 'dotenv/config'
import { createInfra, type Infra } from './infra/index'
import { formatUsd, renderReport, summarizeByUser } from './ledger'
import { FakeClock, TASKS, matches, systemClock, tick } from './scheduler'
import { GROUP, STREAM, consumeOnce, runWorker } from './worker'

const START = new Date('2026-09-04T08:58:00Z')
const MINUTES = 15
const MONTH = '2026-09'
const results: boolean[] = []

// 五项自检的标题与失败提示，提示对应 starter 里的四个练习点
const ITEMS: [string, string][] = [
  ['cron 表达式匹配', 'matchField 的「星号斜杠 n」分支还没实现（练习 1）'],
  ['幂等去重', '幂等键要锚在「计划触发的那一分钟」，不是 Date.now()（练习 2）'],
  ['一条消息只被一个 Worker 消费', '有 run 被重复执行了'],
  ['台账金额', 'costMicroUsd 还没实现：token 数 × 单价 就是微美元（练习 3）'],
  ['usage report 按用户汇总', '汇总还没按 user_id 分组（练习 4）'],
]

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/5] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

/** 用快进时钟把同样的 15 分钟跑 rounds 遍：调度器投递 + 两个 Worker 交替消费。 */
async function replay(infra: Infra, rounds: number) {
  let published = 0
  for (let round = 0; round < rounds; round += 1) {
    const clock = new FakeClock(START)
    for (let i = 0; i < MINUTES; i += 1) {
      published += await tick(infra.bus, clock, STREAM)
      clock.advance(60_000)
    }
  }
  let executed = 0
  let skipped = 0
  for (let i = 0, idle = 0; i < 40 && idle < 2; i += 1) {
    const res = await consumeOnce(infra, i % 2 === 0 ? 'w-1' : 'w-2', 2)
    executed += res.executed
    skipped += res.skipped
    idle = res.read === 0 ? idle + 1 : 0
  }
  return { published, executed, skipped }
}

/** 常驻服务裸跑不会退出，所以自检在一个进程里跑完调度器 + 两个 Worker，逐项打印后退出。 */
async function selfTest(infra: Infra): Promise<number> {
  const minutes = [...Array(MINUTES).keys()].map((i) => new Date(START.getTime() + i * 60_000))
  const hits = TASKS.map((t) => minutes.filter((d) => matches(t.cron, d)).length)
  const ok1 = hits[0] === 3 && hits[1] === 1
  check(1, ok1, `15 分钟内命中 ${hits.join(' / ')} 次（期望 3 / 1）`)

  const { published, executed, skipped } = await replay(infra, 2)
  const ok2 = published === 8 && executed === 4 && skipped === 4
  check(2, ok2, `投递 ${published} / 执行 ${executed} / 挡下 ${skipped}（期望 8 / 4 / 4）`)

  // 每条消息只被一个消费者处理，所以每个 run 应当恰好有 2 条台账（1 chat + 1 embedding）；
  // 出现 4 条就说明同一个 run 被两个 Worker 各执行了一遍。
  const usage = await infra.store.allUsage()
  const perRun = new Map<string, number>()
  for (const row of usage) perRun.set(row.runId ?? '', (perRun.get(row.runId ?? '') ?? 0) + 1)
  const counts = [...perRun.values()]
  const ok3 = counts.length > 0 && counts.every((n) => n === 2) && executed === perRun.size
  check(3, ok3, `${perRun.size} 个 run 的台账条数 ${counts.join('/') || '(无)'}（都应是 2）`)

  const total = usage.reduce((sum, row) => sum + row.costMicroUsd, 0)
  const ok4 = usage.length === 8 && total === 1328
  check(4, ok4, `${usage.length} 条合计 ${formatUsd(total)}（期望 8 条 / $0.001328 = 4×324 + 4×8）`)

  const byUser = summarizeByUser(usage, MONTH)
  const u1 = byUser.find((s) => s.userId === 'u-1')?.micro ?? 0
  const u2 = byUser.find((s) => s.userId === 'u-2')?.micro ?? 0
  const ok5 = byUser.length === 2 && u1 === 996 && u2 === 332
  check(5, ok5, `u-1 ${formatUsd(u1)} / u-2 ${formatUsd(u2)}（期望 $0.000996 / $0.000332）`)

  console.log(`\n${renderReport(usage, MONTH)}`)
  const passed = results.filter(Boolean).length
  console.log(`\n=== 自检结束：${passed}/${results.length} 项通过 ===`)
  return passed === results.length ? 0 : 1
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ''
  const infra = await createInfra()
  await infra.store.init()
  await infra.bus.ensureGroup(STREAM, GROUP)

  if (process.env.SELFTEST === '1') {
    console.log(`=== D13 自检开始（基础设施：${infra.mode}）===`)
    process.exitCode = await selfTest(infra)
  } else if (mode === '--report') {
    // 内存模式下台账不跨进程，先把同一段 15 分钟跑一遍，报表才有数据可汇总
    if (infra.mode === 'memory') await replay(infra, 1)
    const usage = await infra.store.allUsage()
    const month =
      process.env.MONTH ?? (infra.mode === 'memory' ? MONTH : new Date().toISOString().slice(0, 7))
    console.log(
      usage.length === 0 ? `${month} 还没有台账记录。` : `\n${renderReport(usage, month)}`
    )
  } else if (mode === '--worker') {
    await runWorker(infra, process.env.WORKER_ID ?? 'w-1')
    return
  } else {
    // 默认：调度器 + 一个 Worker 在同一进程里跑，方便本机手动观察
    void runWorker(infra, process.env.WORKER_ID ?? 'w-1')
    for (;;) {
      const n = await tick(infra.bus, systemClock, STREAM)
      if (n > 0) console.log(`[调度器] 投递 ${n} 条`)
      await new Promise((resolve) => setTimeout(resolve, 60_000 - (Date.now() % 60_000)))
    }
  }

  await infra.bus.close()
  await infra.store.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
