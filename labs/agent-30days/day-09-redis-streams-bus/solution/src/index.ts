import 'dotenv/config'

import { submitChat } from './gateway/gateway'
import { createBus } from './infra/bus'
import type { Bus } from './infra/bus'
import { CLAIM_MIN_IDLE_MS, DEAD_STREAM, GROUP, REDIS_URL, STREAM, sleep } from './shared/config'
import { createStore } from './shared/store'
import type { Store } from './shared/store'
import { pollOnce, runWorker } from './worker/worker'

const backend = REDIS_URL ? `Redis(${REDIS_URL})` : '内存实现（MOCK）'
const trace = (l: string): void => console.log(`      ${l}`)
const one = { count: 1, blockMs: 10, minIdleMs: 5000 }
const results: boolean[] = []

async function boot(): Promise<{ bus: Bus; store: Store; log: typeof trace }> {
  const bus = createBus()
  // 自检要能反复跑：连真 Redis 时先把上一轮剩下的流删掉，否则消息越积越多
  if (process.env.SELFTEST === '1') await bus.reset([STREAM, DEAD_STREAM])
  await bus.ensureGroup(STREAM, GROUP)
  return { bus, store: createStore(), log: trace }
}

function check(label: string, ok: boolean, detail: string): void {
  results.push(ok)
  console.log(`[${results.length}/5] ${label}${ok ? '✅' : '❌'} ${detail}`)
}

const repliesIn = async (s: Store): Promise<number> =>
  (await s.messages()).filter((x) => x.role === 'assistant').length

/**
 * 自检（MOCK=1 SELFTEST=1 pnpm start）：在一个进程里扮演 gateway 和多个 worker，
 * 按脚本走完今天的五个现象，逐项打 ✅/❌ 后退出。
 */
async function selfTest(): Promise<void> {
  console.log(`=== D9 自检开始（总线后端：${backend}）===`)

  // ── 1 / 2 / 3：同一条流上的完整故事 ─────────────────────────────
  const m = await boot()
  const sent = []
  for (const [i, text] of ['查一下我的订单', '退货怎么办', '发票能重开吗'].entries()) {
    sent.push(await submitChat(m, { sessionId: 's1', text, idempotencyKey: `req-${i + 1}` }))
  }
  const idle = await m.bus.pendingCount(STREAM, GROUP)
  const len = await m.bus.length(STREAM)
  const posted = sent.every((s) => Boolean(s.streamId)) && idle === 0
  check('XADD 投递 3 条、消费组已建立：', posted, `stream ${len} 条，pending ${idle}（还没人消费）`)

  const took: Record<string, number> = { 'worker-a': 0, 'worker-b': 0 }
  for (let i = 0; i < 4; i += 1) {
    const who = i % 2 === 0 ? 'worker-a' : 'worker-b'
    took[who] += (await pollOnce(m, who, one)).handled
  }
  const replied = await repliesIn(m.store)
  const left = await m.bus.pendingCount(STREAM, GROUP)
  const shared = took['worker-a'] > 0 && took['worker-b'] > 0 && replied === 3 && left === 0
  check(
    '消费组分摊 + XACK 销号：',
    shared,
    `a=${took['worker-a']} b=${took['worker-b']}，回复 ${replied} 条，pending ${left}`
  )

  // 闸门一：同一个 idempotencyKey 再提交一次（客户端重试 POST /chat）
  const again = await submitChat(m, {
    sessionId: 's1',
    text: '查一下我的订单',
    idempotencyKey: 'req-1',
  })
  const runCount = (await m.store.runs()).length
  // 闸门二：把已经 done 的那条消息原样再 XADD 一次（模拟 XACK 丢失后的重投）
  await m.bus.publish(STREAM, { runId: sent[0].runId, sessionId: 's1' })
  await pollOnce(m, 'worker-a', one)
  const still = await repliesIn(m.store)
  const guarded = again.duplicated && runCount === 3 && still === 3
  check(
    'at-least-once 两道闸门：',
    guarded,
    `重复提交被挡=${again.duplicated}，run ${runCount} 个（应为 3），回复 ${still} 条`
  )
  await m.bus.close()

  // ── 4：worker 崩在处理中途，另一个 worker 用 XAUTOCLAIM 接手 ────
  const c = await boot()
  await submitChat(c, { sessionId: 's2', text: '我的包裹到哪了', idempotencyKey: 'req-c' })
  const grabbed = await c.bus.readGroup(STREAM, GROUP, 'worker-a', 1, 10)
  trace(`worker-a 取走 ${grabbed[0]?.id ?? '(没取到)'} 后进程被 kill，没有 XACK`)
  const orphan = await c.bus.pendingCount(STREAM, GROUP)
  await sleep(150)
  const got = (await pollOnce(c, 'worker-b', { count: 5, blockMs: 10, minIdleMs: 100 })).claimed
  const allDone = (await c.store.runs()).every((r) => r.status === 'done')
  const rescued =
    orphan === 1 && got === 1 && allDone && (await c.bus.pendingCount(STREAM, GROUP)) === 0
  check(
    'XAUTOCLAIM 让另一个 worker 接手：',
    rescued,
    `崩溃后 pending ${orphan}，worker-b 接手 ${got}，run 全 done=${allDone}`
  )
  await c.bus.close()

  // ── 5：毒消息 ──────────────────────────────────────────────────
  const p = await boot()
  await submitChat(p, { sessionId: 's3', text: 'boom 这条永远处理不成功', idempotencyKey: 'req-p' })
  let tries = 0
  for (let round = 0; round < 5; round += 1) {
    const s = await pollOnce(p, 'worker-c', { count: 5, blockMs: 10, minIdleMs: 60 })
    tries += s.handled + s.failed
    if (s.dead > 0) break
    await sleep(80)
  }
  const deadLen = await p.bus.length(DEAD_STREAM)
  const poison = (await p.store.runs())[0]
  const rest = await p.bus.pendingCount(STREAM, GROUP)
  const isolated = tries === 3 && deadLen === 1 && poison?.status === 'failed' && rest === 0
  check(
    '毒消息隔离：',
    isolated,
    `失败 ${tries} 次，死信流 ${deadLen} 条，run.status=${poison?.status ?? '无'}，pending ${rest}`
  )
  await p.bus.close()

  console.log(`=== 自检结束：${results.filter(Boolean).length}/${results.length} 通过 ===`)
}

/**
 * 常驻模式。mode=demo（默认）先投三条再开始消费，一个终端就能看完整链路；
 * mode=worker 只消费，供开两个终端观察分摊，也是 D14 compose 里 worker 容器的入口。
 */
async function resident(mode: string): Promise<void> {
  const { bus, store } = await boot()
  const id = process.env.WORKER_ID ?? 'worker-1'
  let stopping = false
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.log(`收到 ${sig}，不再取新消息……`)
      stopping = true
    })
  }
  console.log(`${id} 已启动（后端 ${backend}），消费 ${STREAM} / 组 ${GROUP}。Ctrl+C 退出`)
  if (mode === 'demo') {
    for (const [i, text] of ['查订单', '退货怎么办', 'boom 永远失败的那条'].entries()) {
      await submitChat({ bus, store }, { sessionId: 'demo', text, idempotencyKey: `demo-${i}` })
    }
  }
  await runWorker({ bus, store, log: (l) => console.log(l) }, id, () => stopping, {
    count: 10,
    blockMs: 1000,
    minIdleMs: CLAIM_MIN_IDLE_MS,
  })
  await bus.close()
}

async function main(): Promise<void> {
  if (process.env.SELFTEST === '1') return selfTest()
  return resident(process.argv[2] ?? 'demo')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
