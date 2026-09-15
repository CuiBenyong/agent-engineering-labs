import Fastify, { type FastifyInstance } from 'fastify'
import { GROUP, type Config, runsStream, workersKey } from './config'
import { summarizeHealth } from './heartbeat'
import type { Infra } from './infra/index'
import { newRun } from './worker'

interface ChatBody {
  userId?: unknown
  message?: unknown
  workMs?: unknown
}

export interface Gateway {
  app: FastifyInstance
  /** 优雅停机第一步：先让就绪探针转红，等负载均衡把流量摘走，再真的关连接 */
  beginDrain(): void
}

/**
 * 接入层（Gateway）：只鉴权/校验、落库、投递（D8 的形状，本天不改）。
 * 今天加的是两个运维端点——一个回答「我自己能不能接流量」，
 * 一个回答「执行层现在有几个副本活着」。这两个问题必须分开回答，理由见正文。
 */
export function createGateway(infra: Infra, cfg: Config): Gateway {
  const app = Fastify({ logger: false })
  let draining = false

  app.post('/chat', async (request, reply) => {
    if (draining) {
      // 正在下线的实例要主动拒收，而不是收下之后半途而废
      return reply.code(503).send({ error: '实例正在下线，请重试' })
    }
    const body = (request.body ?? {}) as ChatBody
    const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!userId || !message) {
      return reply.code(400).send({ error: 'userId 与 message 都不能为空' })
    }
    const workMs = typeof body.workMs === 'number' ? body.workMs : undefined
    const { row, fields } = newRun(userId, message, workMs)
    const created = await infra.store.createRun(row)
    // 只有真的新建成功才投递，重复提交不会变成两次执行（D8 的幂等键）
    if (created) await infra.bus.publish(runsStream(), fields)
    return reply.code(202).send({ runId: row.id, duplicated: !created })
  })

  /**
   * 就绪探针：只查这台机器自己必需的东西。
   * 绝不把 worker 的心跳算进来——某个 worker 挂了就让所有 Gateway 一起转红，
   * 等于给自己装了一个级联下线的开关（D8 那条 callout 的延伸）。
   */
  app.get('/healthz', async (_request, reply) => {
    if (draining) return reply.code(503).send({ ok: false, draining: true })
    try {
      await infra.store.ping()
      return reply.send({ ok: true, env: process.env.APP_ENV ?? 'dev', stream: runsStream() })
    } catch (err) {
      return reply.code(503).send({ ok: false, error: String(err) })
    }
  })

  /** 心跳面板：给值班的人看，也给告警规则读。它转红不影响本实例接流量。 */
  app.get('/admin/workers', async () => {
    const rows = await infra.presence.list(workersKey())
    return summarizeHealth(rows, Date.now(), cfg.staleMs)
  })

  return {
    app,
    beginDrain: (): void => {
      draining = true
    },
  }
}

export async function startGateway(infra: Infra, cfg: Config, port: number): Promise<Gateway> {
  await infra.bus.ensureGroup(runsStream(), GROUP)
  const gateway = createGateway(infra, cfg)
  // 监听 0.0.0.0：只听 127.0.0.1 的话容器映射了端口也连不上（D7 的头号新手坑）
  await gateway.app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })
  return gateway
}
