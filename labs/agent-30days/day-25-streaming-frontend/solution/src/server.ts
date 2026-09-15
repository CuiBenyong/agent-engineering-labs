/**
 * 后端：本天的固定装置，不是本天的教学内容。
 * 它只负责把 D5 那套事件名套上 SSE 的信封（D7 的做法）推出来，
 * 并实现打断真正生效所依赖的那个 cancel 接口。
 *
 * 三个接口（形状沿用 D11：提交与订阅拆开，重连才有地址可回）：
 *   POST /runs                 建 run，返回 runId；幂等键命中就把已有的 run 接回来
 *   GET  /runs/:runId/stream   订阅输出，支持 Last-Event-ID 续传
 *   POST /runs/:runId/cancel   打断的第二步：让后端真的停下来
 */
import Fastify, { type FastifyInstance } from 'fastify'

export const FLUSH_HEARTBEAT_MS = 15_000

export interface ServerEvent {
  seq: number
  event: string
  data: Record<string, unknown>
}

interface RunRecord {
  id: string
  sessionId: string
  input: string
  events: ServerEvent[]
  finished: boolean
  cancelled: boolean
  /** 被打断时已经吐出去多少个 model:delta，自检拿它证明「后端真的停了」 */
  deltaCount: number
  waiters: Set<(event: ServerEvent) => void>
}

export interface AgentServer {
  fastify: FastifyInstance
  getRun(runId: string): RunRecord | undefined
  /** 等这个 run 走到终态，自检里用 */
  waitFinished(runId: string, timeoutMs?: number): Promise<RunRecord | undefined>
}

/** 离线脚本：一次完整的工具调用序列，前端才有卡片可渲染。 */
const MOCK_SCRIPT_PREFIX = '好的，我先帮您查一下这笔订单的状态。'
const MOCK_SCRIPT_SUFFIX =
  '您的订单 A1002 已经在 9 月 3 日发出，目前在转运中心，预计明天送达。还需要我帮您做点别的吗？'

/** 一整轮会吐出的全部文本。自检拿它判断「后端到底跑完了没有」。 */
export const MOCK_SCRIPT_TEXT = MOCK_SCRIPT_PREFIX + MOCK_SCRIPT_SUFFIX

function nowMs(): number {
  return Date.now()
}

export function createAgentServer(options: { deltaDelayMs?: number } = {}): AgentServer {
  const deltaDelayMs = options.deltaDelayMs ?? 12
  const runs = new Map<string, RunRecord>()
  // 幂等键 → runId。生产里是 runs 表上的唯一约束（D8），这里用一个 Map 把语义写出来。
  const byIdempotencyKey = new Map<string, string>()

  const fastify = Fastify({ logger: false })

  function emit(run: RunRecord, event: string, data: Record<string, unknown>): void {
    const item: ServerEvent = { seq: run.events.length, event, data: { runId: run.id, ...data } }
    item.data.seq = item.seq
    run.events.push(item)
    if (event === 'model:delta') run.deltaCount += 1
    for (const waiter of run.waiters) waiter(item)
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** 每吐一段就看一眼取消标记——D11 的做法：在片段之间的间隙检查，不轮询。 */
  async function streamText(run: RunRecord, text: string): Promise<boolean> {
    for (const ch of text) {
      if (run.cancelled) return false
      emit(run, 'model:delta', { text: ch })
      await sleep(deltaDelayMs)
    }
    return true
  }

  async function runMock(run: RunRecord): Promise<void> {
    emit(run, 'run:start', { input: run.input })
    if (!(await streamText(run, MOCK_SCRIPT_PREFIX))) return finish(run, 'cancelled')

    const callId = `call-${run.id}`
    emit(run, 'tool:proposed', { callId, tool: 'query_order', args: { orderId: 'A1002' } })
    await sleep(deltaDelayMs * 2)
    if (run.cancelled) return finish(run, 'cancelled')
    emit(run, 'tool:start', { callId, tool: 'query_order' })
    const startedAt = nowMs()
    await sleep(deltaDelayMs * 4)
    emit(run, 'tool:end', {
      callId,
      tool: 'query_order',
      result: '{"orderId":"A1002","status":"in_transit","eta":"2026-09-06"}',
      ms: nowMs() - startedAt,
    })

    if (!(await streamText(run, MOCK_SCRIPT_SUFFIX))) return finish(run, 'cancelled')
    finish(run, 'done')
  }

  /** 真实模型：唯一的网络出口，只在没有 MOCK=1 时走。工具事件只有离线脚本里有。 */
  async function runReal(run: RunRecord): Promise<void> {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      emit(run, 'run:error', { message: '缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）' })
      run.finished = true
      return
    }
    emit(run, 'run:start', { input: run.input })
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.MODEL ?? 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: run.input }],
          stream: true,
        }),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        if (run.cancelled) {
          await reader.cancel()
          return finish(run, 'cancelled')
        }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') continue
          const delta = (JSON.parse(payload) as { choices: { delta?: { content?: string } }[] })
            .choices[0]?.delta?.content
          if (delta) emit(run, 'model:delta', { text: delta })
        }
      }
      finish(run, 'done')
    } catch (err) {
      emit(run, 'run:error', { message: err instanceof Error ? err.message : String(err) })
      run.finished = true
    }
  }

  function finish(run: RunRecord, status: 'done' | 'cancelled'): void {
    emit(run, 'run:end', { status, deltas: run.deltaCount })
    run.finished = true
  }

  fastify.post('/runs', async (request, reply) => {
    const body = request.body as {
      sessionId?: string
      message?: string
      idempotencyKey?: string
    }
    const key = body.idempotencyKey ?? ''
    const existing = byIdempotencyKey.get(key)
    if (existing) {
      // 幂等命中：不重跑，把已有的 run 接回去。这是 D8 的 on conflict 在前端重试场景的样子。
      return reply.send({ runId: existing, resumed: true })
    }

    const run: RunRecord = {
      id: `run-${runs.size + 1}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: body.sessionId ?? 's-1',
      input: body.message ?? '',
      events: [],
      finished: false,
      cancelled: false,
      deltaCount: 0,
      waiters: new Set(),
    }
    runs.set(run.id, run)
    if (key) byIdempotencyKey.set(key, run.id)

    const execute = process.env.MOCK === '1' ? runMock : runReal
    void execute(run)
    return reply.send({ runId: run.id, resumed: false })
  })

  fastify.post('/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const run = runs.get(runId)
    if (!run) return reply.code(404).send({ error: 'run not found' })
    run.cancelled = true
    return reply.send({ runId, status: 'cancelling' })
  })

  fastify.get('/runs/:runId/stream', (request, reply) => {
    const { runId } = request.params as { runId: string }
    const run = runs.get(runId)
    if (!run) {
      void reply.code(404).send({ error: 'run not found' })
      return
    }

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const write = (item: ServerEvent): void => {
      raw.write(`id: ${item.seq}\nevent: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
    }

    // Last-Event-ID 是「我最后收到的那一号」，所以从它加一开始（D11 那唯一一行算术）
    const header = request.headers['last-event-id']
    const from = header === undefined ? 0 : Number(header) + 1
    for (const item of run.events) if (item.seq >= from) write(item)

    if (run.finished) {
      raw.end()
      return
    }

    const waiter = (item: ServerEvent): void => {
      write(item)
      if (item.event === 'run:end' || item.event === 'run:error') {
        run.waiters.delete(waiter)
        clearInterval(timer)
        raw.end()
      }
    }
    // 心跳：注释行，客户端安静忽略，但网关拿它判断连接还活着（D7）
    const timer = setInterval(() => raw.write(': ping\n\n'), FLUSH_HEARTBEAT_MS)
    run.waiters.add(waiter)
    raw.on('close', () => {
      run.waiters.delete(waiter)
      clearInterval(timer)
    })
  })

  return {
    fastify,
    getRun: (runId) => runs.get(runId),
    async waitFinished(runId, timeoutMs = 5000) {
      const deadline = nowMs() + timeoutMs
      for (;;) {
        const run = runs.get(runId)
        if (run?.finished) return run
        if (nowMs() > deadline) return run
        await sleep(10)
      }
    },
  }
}
