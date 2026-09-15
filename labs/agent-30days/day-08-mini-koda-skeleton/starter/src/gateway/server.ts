import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { idempotencyKeyFor, newId } from '../shared/schema.js'
import type { Store } from '../infra/store.js'

/** 入参一律先当 unknown 收，再逐个收窄——服务化之后输入不再可信 */
type ChatBody = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * 接入层（Gateway）：只做鉴权、限流、落库、投递四件事。
 * 它们的耗时都是确定的毫秒级，不会因为模型今天慢而变慢——
 * 这就是「能在 Worker 做的不放 Gateway」这条判据的全部含义。
 */
export function buildServer(store: Store): FastifyInstance {
  const app = Fastify({ logger: false })

  // 就绪探针：只查这台机器自己必需的东西，把下游依赖全查一遍等于装了个级联下线开关
  app.get('/health', async () => ({ status: 'ok' }))

  app.post<{ Body: ChatBody }>('/chat', async (request, reply) => {
    const sessionId = asString(request.body?.sessionId)
    const message = asString(request.body?.message)
    const clientMessageId = asString(request.body?.clientMessageId)
    if (!sessionId || !message) {
      return reply.code(400).send({ error: 'sessionId 与 message 必填' })
    }
    // 鉴权在生产里是一个前置钩子（JWT / API key），这里简化成读一个请求头
    const userId = asString(request.headers['x-user-id']) ?? 'demo-user'

    await store.ensureSession({ id: sessionId, userId, title: message.slice(0, 40) })

    const idempotencyKey = idempotencyKeyFor(sessionId, clientMessageId, message)
    const { run, created } = await store.createRun({ sessionId, input: message, idempotencyKey })

    // 只有第一次才写用户消息：seq 从 0 开始，D11 的断线重连按它续传
    if (created) {
      await store.appendMessage({
        id: newId('msg'),
        sessionId,
        runId: run.id,
        role: 'user',
        content: message,
        seq: 0,
      })
    }

    // 第四件事「投递到消息总线」今天是空的：落库到此为止，执行是 D9 的事。
    // 202 Accepted 的语义是「我收下了，正在办」；200 会承诺一个此刻还不存在的结果。
    reply.code(202)
    return { runId: run.id, status: run.status, duplicate: !created }
  })

  return app
}
