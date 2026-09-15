import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Bus } from './infra/bus.js'
import type { Store } from './infra/store.js'
import {
  MERGE_WINDOW_MS,
  RUNS_STREAM,
  isTerminal,
  outStream,
  rerunKey,
  shouldMerge,
} from './shared/run.js'
import {
  SSE_HEADERS,
  SeqOrderer,
  resumeFrom,
  sendEvent,
  sleep,
  startHeartbeat,
} from './shared/net.js'

interface ChatBody {
  sessionId?: unknown
  message?: unknown
  requestId?: unknown
}

/**
 * 接入层（Gateway）：只做鉴权/校验、落库、投递、以及把输出流转成 SSE。
 * 和 D7 最大的不同是接口形状：D7 是 POST 直接吐流；今天拆成
 * POST /chat 建 run（立刻返回 runId）+ GET /runs/:id/stream 订阅输出。
 * 这样断线重连才有地址可回，多个客户端也才能订阅同一个 run。
 */
export function createGateway(bus: Bus, store: Store): FastifyInstance {
  const app = Fastify({ logger: false })

  app.post('/chat', async (request, reply) => {
    const body = (request.body ?? {}) as ChatBody
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!sessionId || !message) {
      return reply.code(400).send({ error: 'sessionId 与 message 都不能为空' })
    }

    const prev = await store.latestRun(sessionId)
    if (prev && shouldMerge(prev, Date.now())) {
      // 打断合并：不新建 run，把新消息追加进同一个 run 的输入，
      // 再置一个「需要重跑」的瞬态标记，worker 会在下一个片段的间隙看到它。
      await store.appendInput(prev.id, message)
      await bus.flagSet(rerunKey(prev.id), MERGE_WINDOW_MS)
      return reply.code(202).send({ runId: prev.id, merged: true })
    }

    const runId = randomUUID()
    // 幂等键优先用客户端带来的 requestId：重复 POST（用户手抖、前端重试）不会变成两个 run
    const idempotencyKey =
      typeof body.requestId === 'string' && body.requestId ? body.requestId : runId
    const run = await store.createRun({ id: runId, sessionId, idempotencyKey, input: message })
    // 只有真的新建成功才投递，否则重复请求会让同一个 run 被执行两次
    if (run.id === runId) await bus.publish(RUNS_STREAM, { runId })
    return reply.code(202).send({ runId: run.id, merged: false })
  })

  app.get('/runs/:runId/stream', async (request, reply) => {
    const { runId } = request.params as { runId: string }
    if (!(await store.getRun(runId))) return reply.code(404).send({ error: 'run 不存在' })

    // 浏览器原生 EventSource 会把上一次收到的 id 放进 Last-Event-ID 请求头；
    // 手写客户端（POST 场景下只能手写）用查询参数也一样，两条路都收。
    const header = request.headers['last-event-id']
    const query = request.query as { lastEventId?: string }
    const from = resumeFrom(typeof header === 'string' ? header : query.lastEventId)

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, SSE_HEADERS)
    res.write(': open\n\n')
    const stopHeartbeat = startHeartbeat(res)
    let closed = false
    res.on('close', () => {
      closed = true
    })

    const orderer = new SeqOrderer(from, (seq, text) =>
      sendEvent(res, 'delta', { text }, String(seq))
    )
    // 先从库里回放错过的片段，再接上流——两边必然重叠，靠 SeqOrderer 的丢弃逻辑去重
    for (const row of await store.listDeltas(runId, from)) orderer.offer(row.seq, row.content)

    let cursor = '0'
    try {
      while (!closed) {
        const batch = await bus.read(outStream(runId), cursor, 64)
        for (const message of batch) {
          cursor = message.id
          const seq = Number(message.fields.seq)
          if (Number.isInteger(seq)) orderer.offer(seq, message.fields.text ?? '')
        }
        const current = await store.getRun(runId)
        if (current && isTerminal(current.status) && batch.length === 0) {
          // 收尾前以库为准补一次：流上可能还有没到齐的号，库里一定是全的
          for (const row of await store.listDeltas(runId, orderer.next)) {
            orderer.offer(row.seq, row.content)
          }
          const event = current.status === 'done' ? 'done' : 'error'
          sendEvent(res, event, {
            status: current.status,
            chunks: orderer.count,
            error: current.error,
          })
          break
        }
        await sleep(20)
      }
    } finally {
      stopHeartbeat()
      if (!res.writableEnded) res.end()
    }
  })

  return app
}
