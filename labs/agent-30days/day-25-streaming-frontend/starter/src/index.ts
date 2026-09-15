/**
 * 入口：三种模式。
 *   MOCK=1 SELFTEST=1 pnpm start   自检——浏览器 UI 没法自测，所以核心逻辑全是纯函数，这里直接测它们
 *   MOCK=1 pnpm start              只起后端，供 curl
 *   MOCK=1 pnpm dev                起后端 + Vite，浏览器里真的看一眼
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { createAgentServer, MOCK_SCRIPT_TEXT } from './server'
import {
  consumeRun,
  createFlushScheduler,
  newAttempt,
  retryAttempt,
  startRun,
  stopRun,
} from './stream/client'
import { createSseParser } from './stream/parse'
import { decodeFrame, emptyTurn, reduceEvent } from './stream/reduce'

const PORT = Number(process.env.PORT ?? 3025)
const WEB_PORT = Number(process.env.WEB_PORT ?? 4025)
const BASE_URL = `http://127.0.0.1:${PORT}`

const ITEMS: [string, string][] = [
  ['SSE 增量解析（报文被切碎）', '解析器没有跨块缓冲（练习 1）'],
  ['三个工具事件归并成一张卡片', 'tool:* 没有按 callId 归并（练习 2）'],
  ['端到端消费一整轮流（文本与事件序列）', '文本或事件序列对不上'],
  ['打断两步：后端真的停了', '只 abort 没发 cancel（练习 3）'],
  ['对照组：只 abort 时后端照跑不误', '对照组本身跑歪了'],
  ['重试复用同一个幂等键', '重试换了新的 idempotencyKey（练习 4）'],
  ['节流 flush：批次数远小于 token 数', 'flush 没有节流（练习 5）'],
]

const results: boolean[] = []

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/${ITEMS.length}] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 一段真实形状的报文：带心跳注释行、带汉字，故意按 7 字节切碎再喂进去。 */
function chopFixture(): string[] {
  const text = [
    'id: 0\nevent: run:start\ndata: {"runId":"r-1","seq":0}\n\n',
    ': ping\n\n',
    'id: 1\nevent: model:delta\ndata: {"runId":"r-1","seq":1,"text":"您好，"}\n\n',
    'id: 2\nevent: model:delta\ndata: {"runId":"r-1","seq":2,"text":"正在查询"}\n\n',
    'id: 3\nevent: run:end\ndata: {"runId":"r-1","seq":3,"status":"done"}\n\n',
  ].join('')
  const bytes = new TextEncoder().encode(text)
  const decoder = new TextDecoder()
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 7) {
    chunks.push(decoder.decode(bytes.slice(i, i + 7), { stream: true }))
  }
  return chunks
}

function testParser(): void {
  const parse = createSseParser()
  const events: string[] = []
  let text = ''
  for (const chunk of chopFixture()) {
    for (const frame of parse(chunk)) {
      const decoded = decodeFrame(frame)
      if (!decoded) continue
      events.push(decoded.event)
      if (decoded.event === 'model:delta') text += String(decoded.payload.text ?? '')
    }
  }
  const ok =
    events.join(',') === 'run:start,model:delta,model:delta,run:end' && text === '您好，正在查询'
  check(1, ok, `解出 ${events.length} 个事件、文本「${text}」`)
}

function testToolMerge(): void {
  let turn = emptyTurn('r-1')
  const events: [string, Record<string, unknown>][] = [
    ['run:start', { seq: 0 }],
    ['tool:proposed', { seq: 1, callId: 'c-1', tool: 'query_order', args: { orderId: 'A1002' } }],
    ['tool:start', { seq: 2, callId: 'c-1', tool: 'query_order' }],
    [
      'tool:end',
      { seq: 3, callId: 'c-1', tool: 'query_order', result: '{"status":"in_transit"}', ms: 42 },
    ],
    // 重连回放：这一条是旧的，必须被丢弃，不能把卡片打回 running
    ['tool:start', { seq: 2, callId: 'c-1', tool: 'query_order' }],
    ['run:end', { seq: 4, status: 'done' }],
  ]
  for (const [event, payload] of events) turn = reduceEvent(turn, event, payload)
  const card = turn.tools[0]
  const ok =
    turn.tools.length === 1 &&
    card?.status === 'done' &&
    card.name === 'query_order' &&
    card.args.orderId === 'A1002' &&
    turn.status === 'done'
  check(2, ok, `卡片 ${turn.tools.length} 张、状态 ${card?.status ?? '无'}`)
}

interface Consumed {
  text: string
  events: string[]
  toolCount: number
}

async function consumeAll(runId: string, controller: AbortController): Promise<Consumed> {
  let turn = emptyTurn(runId)
  const events: string[] = []
  try {
    await consumeRun({
      baseUrl: BASE_URL,
      runId,
      signal: controller.signal,
      onFrame(frame) {
        const decoded = decodeFrame(frame)
        if (!decoded) return
        events.push(decoded.event)
        turn = reduceEvent(turn, decoded.event, decoded.payload as Record<string, unknown>)
      },
    })
  } catch {
    /* abort 会让 read() 抛错，这里就是打断的正常出口 */
  }
  return { text: turn.text, events, toolCount: turn.tools.length }
}

async function testEndToEnd(): Promise<void> {
  const attempt = newAttempt('我的订单 A1002 到哪了')
  const started = await startRun(BASE_URL, 's-1', attempt)
  const got = await consumeAll(started.runId, new AbortController())
  // 这一项只看「字有没有收全、事件序列对不对」，卡片归并是第 2 项的事。
  // 本机直连时帧不会被切开，所以练习 1 没做也能过——弱网才露馅，这正是它值得单独测的原因。
  const ok =
    got.text === MOCK_SCRIPT_TEXT &&
    got.events.includes('tool:proposed') &&
    got.events.includes('tool:start') &&
    got.events.includes('tool:end') &&
    got.events.at(-1) === 'run:end'
  check(3, ok, `收到 ${got.events.length} 个事件、${got.text.length} 个字`)
}

/** 消费到第 n 个 delta 就返回，剩下的交给调用方决定打断还是放着。 */
async function consumeUntilDeltas(
  runId: string,
  controller: AbortController,
  n: number
): Promise<void> {
  let seen = 0
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  void consumeRun({
    baseUrl: BASE_URL,
    runId,
    signal: controller.signal,
    onFrame(frame) {
      const decoded = decodeFrame(frame)
      if (decoded?.event === 'model:delta' && ++seen >= n) resolveReady()
    },
  }).catch(() => resolveReady())
  await ready
}

async function testCancelBothSteps(server: ReturnType<typeof createAgentServer>): Promise<void> {
  const started = await startRun(BASE_URL, 's-1', newAttempt('第一条：会被打断'))
  const controller = new AbortController()
  await consumeUntilDeltas(started.runId, controller, 5)

  // 打断的两步都做：中止读取 + POST /runs/:id/cancel
  await stopRun(controller, BASE_URL, started.runId)
  const at = server.getRun(started.runId)?.deltaCount ?? 0
  const run = await server.waitFinished(started.runId, 3000)
  const last = run?.events.at(-1)
  const ok =
    run?.cancelled === true &&
    last?.event === 'run:end' &&
    last.data.status === 'cancelled' &&
    (run?.deltaCount ?? 0) < MOCK_SCRIPT_TEXT.length
  check(4, ok, `打断时吐了 ${at} 个字，最终停在 ${run?.deltaCount ?? 0}/${MOCK_SCRIPT_TEXT.length}`)
}

async function testAbortOnly(server: ReturnType<typeof createAgentServer>): Promise<void> {
  const started = await startRun(BASE_URL, 's-1', newAttempt('第二条：只 abort 不 cancel'))
  const controller = new AbortController()
  await consumeUntilDeltas(started.runId, controller, 5)

  // 只做第一步：我不听了。后端并不知道，会一路跑完——这就是本章的立论点。
  controller.abort()
  const at = server.getRun(started.runId)?.deltaCount ?? 0
  const run = await server.waitFinished(started.runId, 5000)
  const last = run?.events.at(-1)
  const ok =
    run?.cancelled === false &&
    last?.data.status === 'done' &&
    run?.deltaCount === MOCK_SCRIPT_TEXT.length
  check(
    5,
    ok,
    `abort 时吐了 ${at} 个字，后端仍跑到 ${run?.deltaCount ?? 0}/${MOCK_SCRIPT_TEXT.length}`
  )
}

async function testRetryIdempotency(): Promise<void> {
  const attempt = newAttempt('第三条：会失败然后重试')
  const first = await startRun(BASE_URL, 's-1', attempt)
  const again = await startRun(BASE_URL, 's-1', retryAttempt(attempt))
  const other = await startRun(BASE_URL, 's-1', newAttempt('另一句话'))
  const ok = again.runId === first.runId && again.resumed === true && other.runId !== first.runId
  check(
    6,
    ok,
    `重试拿回 ${again.runId === first.runId ? '同一个' : '另一个'} run（resumed=${again.resumed}）`
  )
  await consumeAll(first.runId, new AbortController())
  await consumeAll(other.runId, new AbortController())
}

async function testFlushThrottle(): Promise<void> {
  const tokens = Array.from({ length: 200 }, (_, i) => String.fromCharCode(19968 + (i % 200)))
  let flushes = 0
  let joined = ''
  const scheduler = createFlushScheduler((batch) => {
    flushes += 1
    joined += batch
  })
  for (const token of tokens) {
    scheduler.push(token)
    await sleep(1)
  }
  scheduler.flushNow()
  scheduler.stop()
  const ok = joined === tokens.join('') && flushes <= 20
  check(7, ok, `${tokens.length} 个 token 只提交了 ${flushes} 次渲染`)
}

async function selfTest(server: ReturnType<typeof createAgentServer>): Promise<number> {
  testParser()
  testToolMerge()
  await testEndToEnd()
  await testCancelBothSteps(server)
  await testAbortOnly(server)
  await testRetryIdempotency()
  await testFlushThrottle()

  const passed = results.filter(Boolean).length
  console.log(`=== ${passed}/${results.length} 项通过 ===`)
  return passed === results.length ? 0 : 1
}

async function main(): Promise<void> {
  const mock = process.env.MOCK === '1'
  const server = createAgentServer({ deltaDelayMs: mock ? 8 : 0 })
  await server.fastify.listen({ port: PORT, host: '127.0.0.1' })

  if (process.env.SELFTEST === '1') {
    console.log(`=== D25 自检开始（后端 ${BASE_URL}，模型：${mock ? 'mock' : 'openrouter'}）===`)
    process.exitCode = await selfTest(server)
    await server.fastify.close()
    return
  }

  console.log(`后端已启动：${BASE_URL}（模型：${mock ? 'mock' : 'openrouter'}）`)
  if (!process.argv.includes('--dev')) {
    console.log(`curl -s -X POST ${BASE_URL}/runs -H 'Content-Type: application/json' \\`)
    console.log(
      `  -d '{"sessionId":"s-1","message":"订单 A1002 到哪了","idempotencyKey":"msg:demo"}'`
    )
    console.log(`curl -N ${BASE_URL}/runs/<runId>/stream`)
    return
  }

  // pnpm dev：顺手把 Vite 拉起来，前端在 4025，通过 proxy 打到后端
  const vite = spawn('pnpm', ['exec', 'vite', '--port', String(WEB_PORT), '--strictPort'], {
    stdio: 'inherit',
  })
  vite.on('exit', (code) => process.exit(code ?? 0))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
