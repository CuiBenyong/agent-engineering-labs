import { loadConfig } from './shared/config.js'
import { newId } from './shared/schema.js'
import { buildServer } from './gateway/server.js'
import { inspectPending } from './worker/inspect.js'
import { MemoryStore } from './infra/memory-store.js'
import { PgStore } from './infra/pg-store.js'
import { IllegalTransitionError, transitionRun } from './infra/store.js'
import type { Store } from './infra/store.js'

/** 唯一的实现选择点：MOCK=1 走内存，配了 DATABASE_URL 走真库。业务代码感知不到差别。 */
async function createStore(mock: boolean, databaseUrl: string | undefined): Promise<Store> {
  if (mock || !databaseUrl) return new MemoryStore()
  return PgStore.connect(databaseUrl)
}

let failures = 0

function report(no: number, ok: boolean, text: string, why: string): void {
  if (!ok) failures += 1
  console.log(`[${no}/6] ${text} ${ok ? '✅' : `❌ ${why}`}`)
}

async function postChat(baseUrl: string, sessionId: string, message: string, cmid: string) {
  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, clientMessageId: cmid }),
  })
  const json = (await res.json()) as { runId: string; status: string; duplicate: boolean }
  // 注意别让 HTTP 状态码和 run 的 status 撞名——它们是两个东西
  return { httpStatus: res.status, ...json }
}

/** 自检模式：常驻进程没法当验收命令用，所以启动后自己给自己发请求、逐项打印再退出。 */
async function selfTest(baseUrl: string, store: Store, mock: boolean): Promise<void> {
  console.log(
    `=== 自检开始（存储：${mock ? '内存实现，不需要 Docker 与 Postgres' : 'Postgres'}）===`
  )

  const health = await fetch(`${baseUrl}/health`)
  report(1, health.status === 200, `GET /health → ${health.status}`, '编排系统靠它判断能不能接流量')

  const sessA = newId('sess')
  const first = await postChat(baseUrl, sessA, '我的订单还没发货', 'cm-1')
  const msgs = await store.listMessagesByRun(first.runId)
  const ok2 = first.httpStatus === 202 && Boolean(first.runId) && msgs.length === 1
  report(
    2,
    ok2,
    `POST /chat → ${first.httpStatus} runId=${first.runId} 用户消息 ${msgs.length} 条`,
    '拆开之后 Gateway 手里没有结果，只能给 202'
  )

  // 幂等：同一个 clientMessageId 再发一次，必须落到同一条 run
  const again = await postChat(baseUrl, sessA, '我的订单还没发货', 'cm-1')
  const runsA = await store.listRunsBySession(sessA)
  report(
    3,
    again.runId === first.runId && runsA.length === 1,
    `重复投递 → runId ${again.runId === first.runId ? '相同' : '不同'}，该会话共 ${runsA.length} 条 run`,
    '幂等键要由请求内容决定，且靠唯一约束兜底'
  )

  // 状态机：合法迁移放行，终态迁移拒绝
  const forStatus = await postChat(baseUrl, newId('sess'), '要退款', 'cm-2')
  let legal = false
  let rejected = false
  try {
    await transitionRun(store, forStatus.runId, 'running')
    legal = true
    await transitionRun(store, forStatus.runId, 'streaming')
    await transitionRun(store, forStatus.runId, 'done')
    await transitionRun(store, forStatus.runId, 'running') // 应该在这里被拒
  } catch (err) {
    rejected = err instanceof IllegalTransitionError
  }
  const status = (await store.getRun(forStatus.runId))?.status
  report(
    4,
    legal && rejected && status === 'done',
    `pending → running 放行、done → running ${rejected ? '被拒' : '竟然通过了'}，最终状态 ${status}`,
    'done 被推回 running 会覆盖用户已经收到的回复'
  )

  // 复合唯一：同一次执行的同一个序号只能写一次
  const dup = await store.appendMessage({
    id: newId('msg'),
    sessionId: sessA,
    runId: first.runId,
    role: 'user',
    content: '我的订单还没发货',
    seq: 0,
  })
  const afterDup = await store.listMessagesByRun(first.runId)
  report(
    5,
    dup === false && afterDup.length === 1,
    `重复写入 seq=0 → ${dup ? '写进去了' : '被挡下'}，messages 共 ${afterDup.length} 条`,
    'unique(run_id, seq) 是 D11 断线重连能续上的前提'
  )

  const pending = await inspectPending(store, 10)
  report(
    6,
    pending.some((r) => r.id === first.runId),
    `Worker 侧只读查询看到 ${pending.length} 条 pending run（今天不执行，D9 接总线）`,
    '状态挪出进程内存之后，两段才能看到同一份数据'
  )

  console.log(`=== 自检结束：${failures === 0 ? '全部通过 ✅' : `${failures} 项未通过 ❌`} ===`)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const store = await createStore(config.mock, config.databaseUrl)
  const app = buildServer(store)
  await app.listen({ port: config.port, host: config.host })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port

  if (config.selfTest) {
    await selfTest(`http://127.0.0.1:${port}`, store, config.mock)
    await app.close()
    await store.close()
    process.exit(failures === 0 ? 0 : 1)
  }

  console.log(
    `Gateway 已启动：http://127.0.0.1:${port}（${config.mock ? '内存存储' : 'Postgres'}）`
  )
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`收到 ${signal}，停止接受新连接……`)
      void app
        .close()
        .then(() => store.close())
        .then(() => process.exit(0))
    })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
