import 'dotenv/config'
import Fastify from 'fastify'
import type { ServerResponse } from 'node:http'

const PORT = Number(process.env.PORT ?? 3000)
// 容器里必须监听 0.0.0.0：只听 127.0.0.1 的话宿主机 curl 不进来，
// 而这个坑在本机直接 pnpm start 时完全看不出来
const HOST = process.env.HOST ?? '0.0.0.0'
const MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini'
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 15000)

/**
 * SSE 的四个响应头，一个都不能少：
 * - text/event-stream：浏览器的 EventSource 只认这个类型，写成 application/json 会被直接拒收
 * - no-cache, no-transform：no-transform 是防中间代理「好心」帮你压缩或改写正文
 * - keep-alive：这条连接要一直开着
 * - X-Accel-Buffering: no：Nginx 默认会攒够一个缓冲区再转发，攒着攒着流式就变成一次性返回了
 */
const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

interface ChatBody {
  message?: unknown
  sessionId?: unknown
}

interface RunStats {
  /** 这一轮实际生成了多少个片段——用来证明「客户端断开后服务端真的停下来了」 */
  generated: number
  aborted: boolean
  heartbeat: boolean
}

/** 最近一次 /chat 的统计，自检模式会读它 */
const lastRun: RunStats = { generated: 0, aborted: false, heartbeat: false }

/**
 * 按 sessionId 隔离的会话历史。
 * 脚本时代一份历史天然属于你自己，不用问「这条消息是谁的」；
 * 变成服务之后同一个进程要同时服务很多人，不按会话隔离就会串台。
 * D6 你已经把历史写进 .sessions/*.jsonl 了，但那条路服务化之后失效：
 * 多个实例各写各的本地盘，用户第二次请求被负载均衡打到另一台就读不到自己的历史。
 * 所以这里退一步用进程内存的 Map 先把服务跑通，D8 再换成 Postgres。
 */
const histories = new Map<string, string[]>()

function historyOf(sessionId: string): string[] {
  const existing = histories.get(sessionId)
  if (existing) return existing
  const created: string[] = []
  histories.set(sessionId, created)
  return created
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 唯一的网络出口，同时也是**本实验里 Agent 内核的最小替身**：
 * 它只做「把模型回复一个字一个字吐出来」这一件事，没有工具、没有历史回填。
 * 本实验聚焦服务层（SSE 分帧、心跳、断开、容器化），前几天那个完整的 Agent
 * （D3 的循环 + D4 的模型调用层 + D5 的工具与事件）接进来只是把这个函数换掉，
 * 对外的接口形状一行都不用改。
 * MOCK=1 时整段真实请求一行都不执行。
 * signal 一路透传到 fetch：客户端断开时我们要真的把上游请求也掐掉，
 * 否则模型还在生成，token 照付，只是没人收。
 */
async function* streamChat(message: string, signal: AbortSignal): AsyncGenerator<string> {
  if (process.env.MOCK === '1') {
    const canned = `这是离线模拟回复（你问的是「${message}」）：这段话正被一个字一个字地推给你，每个字之间隔 30 毫秒。去掉 MOCK=1 并在 .env 里配置 OPENROUTER_API_KEY，就能连上真模型。`
    for (const ch of canned) {
      if (signal.aborted) return
      await sleep(30)
      yield ch
    }
    return
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: message }],
      stream: true,
    }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`上游返回 HTTP ${res.status}`)

  // 这一段是 D1 的客户端解析逻辑：逐块读、按行切、最后一段半行留到下一轮
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice('data: '.length).trim()
      if (data === '[DONE]') return
      const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
      const delta = parsed.choices?.[0]?.delta?.content
      if (delta) yield delta
    }
  }
}

/**
 * 把一段数据写成一帧合法的 SSE 报文。
 * 格式要点：每行 `字段: 值`，**空行才代表一帧结束**——少写一个 \n
 * 客户端就会一直等下去，看起来像「服务端卡住了」。
 * id 是发给客户端记的号，浏览器原生 EventSource 重连时会用 Last-Event-ID 带回来。
 */
function sendEvent(res: ServerResponse, event: string, data: unknown, id?: string): void {
  if (res.writableEnded) return
  let frame = ''
  if (id !== undefined) frame += `id: ${id}\n`
  frame += `event: ${event}\n`
  // JSON.stringify 的结果天然不含裸换行，正好满足 data 必须单行的要求
  frame += `data: ${JSON.stringify(data)}\n\n`
  res.write(frame)
}

/**
 * 心跳：定时往连接里写一个注释行。
 * 以冒号开头的行是 SSE 的注释，客户端会忽略它，但对链路上的
 * 负载均衡和网关来说这就是「还活着」的字节——它们的空闲超时通常只有 60–120 秒，
 * 而模型吐出第一个 token 之前的静默期完全可能超过这个数。
 */
function startHeartbeat(res: ServerResponse): () => void {
  lastRun.heartbeat = true
  const timer = setInterval(() => {
    if (res.writableEnded) return
    res.write(': ping\n\n')
  }, HEARTBEAT_MS)
  // unref 让这个定时器不要顶住进程退出
  timer.unref()
  return () => clearInterval(timer)
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } })

app.get('/healthz', async () => ({ ok: true, model: MODEL, mock: process.env.MOCK === '1' }))

app.post('/chat', async (request, reply) => {
  const body = (request.body ?? {}) as ChatBody
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'anon'

  // 还没开始推流，这时候才能用 HTTP 状态码表达错误——
  // 一旦写出 200 和第一个字节，状态码就已经发出去了，改不了。
  if (message === '') {
    return reply.code(400).send({ error: 'message 不能为空' })
  }

  // 交出响应控制权：SSE 要自己写原始字节，不能让 Fastify 帮忙序列化
  reply.hijack()
  const res = reply.raw
  res.writeHead(200, SSE_HEADERS)
  // 立刻写一个注释行，把响应头真正刷到网络上，客户端才会认为连接已建立
  res.write(': open\n\n')

  const controller = new AbortController()
  // 监听的是 **响应对象** 的 close，不是 request 的：
  // Node 里 request 的 'close' 在请求体读完时就会触发（而不是连接断开时），
  // 拿它当断线信号会让每一条正常请求都被误判成「客户端跑了」。
  // 响应对象的 'close' 在连接真正关闭时触发，用 writableEnded 区分「正常收尾」和「被掐断」。
  res.on('close', () => {
    if (!res.writableEnded) {
      lastRun.aborted = true
      controller.abort()
    }
  })

  lastRun.generated = 0
  lastRun.aborted = false
  lastRun.heartbeat = false

  const stopHeartbeat = startHeartbeat(res)
  const history = historyOf(sessionId)
  history.push(`user: ${message}`)

  let seq = 0
  let answer = ''

  try {
    for await (const chunk of streamChat(message, controller.signal)) {
      seq += 1
      lastRun.generated = seq
      answer += chunk
      sendEvent(res, 'delta', { text: chunk }, String(seq))
    }
    if (controller.signal.aborted) {
      console.log(`[断开] 客户端已离开，生成 ${seq} 个片段后停止`)
    } else {
      history.push(`assistant: ${answer}`)
      sendEvent(res, 'done', { chunks: seq, turns: history.length })
    }
  } catch (err) {
    // 200 已经发出去了，错误没法再用状态码表达，只能在流里发一个 error 事件——
    // 所以流式接口的错误约定必须写进接口文档，客户端要专门处理这个事件。
    sendEvent(res, 'error', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    stopHeartbeat()
    if (!res.writableEnded) res.end()
  }
})

/** 把一段 SSE 响应体解析成事件列表（自检用的迷你客户端） */
async function readSse(
  res: Response,
  onDelta?: () => void
): Promise<{ event: string; data: string }[]> {
  const events: { event: string; data: string }[] = []
  if (!res.body) return events
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = 'message'
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('event: ')) currentEvent = line.slice('event: '.length).trim()
      else if (line.startsWith('data: ')) {
        events.push({ event: currentEvent, data: line.slice('data: '.length) })
        if (currentEvent === 'delta') onDelta?.()
        currentEvent = 'message'
      }
    }
  }
  return events
}

/**
 * 自检模式（SELFTEST=1）：服务是常驻进程，裸跑不会退出，没法当验收命令用。
 * 所以启动后自己给自己发两轮请求，把结果打印出来再退出——
 * 这样 `MOCK=1 SELFTEST=1 pnpm start` 就是一条能进 CI 的验收命令。
 */
async function selfTest(baseUrl: string): Promise<void> {
  console.log('=== 自检开始 ===')

  // 这两项属于脚手架已经写好的部分，starter 原样跑就是 ✅；
  // 四项都带明确标记，才不用猜「没打号的算过还是没过」。
  const health = await fetch(`${baseUrl}/healthz`)
  const healthOk = health.status === 200
  console.log(
    `[1/4] GET /healthz → ${health.status} ${await health.text()} ${healthOk ? '✅' : '❌ 编排系统靠它判断实例能不能接流量'}`
  )

  const bad = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  console.log(
    `[2/4] POST /chat（空 message）→ ${bad.status} ${bad.status === 400 ? '✅' : '❌'}（推流之前才能用状态码报错）`
  )

  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '把服务跑起来了吗', sessionId: 'selftest' }),
  })
  const contentType = res.headers.get('content-type') ?? '(无)'
  const ok = contentType.startsWith('text/event-stream')
  console.log(
    `[3/4] POST /chat → ${res.status}，Content-Type: ${contentType} ${ok ? '✅' : '❌ 浏览器的 EventSource 会拒收这条连接'}`
  )
  const events = await readSse(res)
  const deltas = events.filter((e) => e.event === 'delta')
  const text = deltas.map((e) => (JSON.parse(e.data) as { text: string }).text).join('')
  console.log(
    `      收到 ${deltas.length} 个 delta 事件、${events.filter((e) => e.event === 'done').length} 个 done 事件`
  )
  console.log(`      拼回来的回复：${text || '(空——说明帧格式不对，客户端一个事件都没解析出来)'}`)

  // 第二轮：读到几个片段就主动断开，验证服务端会停止生成
  const controller = new AbortController()
  let received = 0
  const aborting = fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '这一轮我会中途关掉页面', sessionId: 'selftest' }),
    signal: controller.signal,
  })
    .then((r) =>
      readSse(r, () => {
        received += 1
        if (received === 5) controller.abort()
      })
    )
    .catch(() => [])
  await aborting
  await sleep(400)
  const stopped = lastRun.aborted && lastRun.generated < 30
  console.log(
    `[4/4] 客户端读到 5 个片段就断开：服务端一共生成了 ${lastRun.generated} 个片段` +
      `${stopped ? ' ✅ 断开后停止生成' : ' ❌ 客户端已经走了，服务端还在把整段话生成完——token 照付'}`
  )
  console.log(
    `      心跳定时器：${lastRun.heartbeat ? `已启用（每 ${HEARTBEAT_MS} 毫秒一个注释行）✅` : '未启用 ❌ 空闲久了会被网关掐断'}`
  )

  console.log('=== 自检结束 ===')
}

async function main(): Promise<void> {
  await app.listen({ port: PORT, host: HOST })
  console.log(`agent-service 已启动：http://127.0.0.1:${PORT}（MOCK=${process.env.MOCK ?? '0'}）`)

  if (process.env.SELFTEST === '1') {
    await selfTest(`http://127.0.0.1:${PORT}`)
    await app.close()
    return
  }

  // 优雅退出：容器 docker stop 时收到的是 SIGTERM。
  // 先停止接受新连接，再给在途的 SSE 流一点收尾时间，最后才退出。
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`收到 ${signal}，停止接受新连接……`)
      void app.close().then(() => process.exit(0))
    })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
