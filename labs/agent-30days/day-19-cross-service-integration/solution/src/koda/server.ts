/**
 * 被调用方（mini-koda）这一侧：验签、判 scope、提供 inject / memory / usage 三类接口。
 *
 * 全文只有一条安全不变量，但它管住了整个文件：
 *   身份只能来自 token 的 sub，绝不能来自请求体。
 * 请求体是调用方随便写的，token 是签过名的。
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { AUDIENCE } from '../agent/issuer'
import type { Store } from '../infra/index'
import { type Caller, type Scope, formatUsd, parseScopes } from '../shared/types'
import { recordExternalEvent } from './events'

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller
  }
}

export interface KodaOptions {
  store: Store
  port: number
  issuerUrl: string
  jwksUrl: string
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

function callerOf(req: FastifyRequest): Caller {
  // 验签钩子跑在所有路由之前，走到这里 caller 必然已经填好了
  if (!req.caller) throw new Error('未经验签的请求不该走到这里')
  return req.caller
}

export function createKodaServer(opts: KodaOptions): FastifyInstance {
  const { store } = opts
  // 远端公钥集合。jose 会缓存并在遇到没见过的 kid 时重新拉取——
  // 所以对方轮换密钥时，这边一行配置都不用改，更不用重启。
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl))
  const app = Fastify({ logger: false })

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/health')) return
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return reply.code(401).send({ error: 'missing_token' })
    try {
      // 验签的同时校验 iss / aud / exp。少校验一项都会开一个口子：
      // 不验 aud，别人签给第三方服务的 token 也能拿来打你。
      const { payload } = await jwtVerify(token, jwks, {
        issuer: opts.issuerUrl,
        audience: AUDIENCE,
        algorithms: ['RS256'],
      })
      req.caller = {
        userId: String(payload.sub ?? ''),
        issuer: String(payload.iss ?? ''),
        scopes: parseScopes(payload.scope),
        jti: String(payload.jti ?? ''),
      }
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String(err.code) : 'invalid_token'
      return reply.code(401).send({ error: 'invalid_token', reason: code })
    }
  })

  const requireScope =
    (scope: Scope) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!callerOf(req).scopes.includes(scope)) {
        // 403 而不是 401：身份是真的，只是这张 token 没被授予这个权限
        await reply.code(403).send({ error: 'insufficient_scope', required: scope })
      }
    }

  app.get('/health', async () => ({ ok: true }))

  // ── inject：把一条外部事件注入到这个用户的会话里 ──────────────────────────
  app.post('/v1/inject', { preHandler: requireScope('inject:write') }, async (req, reply) => {
    const caller = callerOf(req)
    const body = bodyOf(req)
    const externalId = stringField(body, 'externalId')
    const text = stringField(body, 'text')
    if (!externalId || !text) {
      return reply.code(400).send({ error: 'externalId 和 text 必填' })
    }
    // 身份只来自 token。body.userId 就算写了也当没看见。
    const userId = caller.userId

    const { created, key } = await recordExternalEvent(store, caller, 'inject', externalId, {
      text,
    })
    if (!created) {
      // 重复送达不是错误，是正常现象：告诉调用方「这条我处理过了」，并且不产生第二次副作用
      return reply.code(200).send({ status: 'duplicate', externalId: key })
    }
    const sessionId = await store.ensureSession(userId)
    const seq = (await store.listMessages(sessionId)).length
    await store.insertMessage({
      id: randomUUID(),
      sessionId,
      runId: null,
      role: 'user',
      content: text,
      seq,
    })
    return reply.code(201).send({ status: 'created', userId, sessionId, seq, externalId: key })
  })

  // ── memory：跨服务读写这个用户的长期记忆（D12 那张表） ────────────────────
  app.post('/v1/memory', { preHandler: requireScope('memory:write') }, async (req, reply) => {
    const caller = callerOf(req)
    const body = bodyOf(req)
    const content = stringField(body, 'content')
    if (!content) return reply.code(400).send({ error: 'content 必填' })
    // 同一条不变量：写谁的记忆由 token 说了算
    const userId = caller.userId
    await store.insertMemory({
      id: randomUUID(),
      userId,
      sourceRunId: null,
      content,
      createdAt: new Date().toISOString(),
    })
    return reply.code(201).send({ status: 'created', userId })
  })

  app.get('/v1/memory', { preHandler: requireScope('memory:read') }, async (req) => {
    const caller = callerOf(req)
    const rows = await store.listMemories(caller.userId)
    return { userId: caller.userId, memories: rows.map((r) => r.content) }
  })

  // ── usage：跨服务查这个用户的成本（D13 那张台账） ─────────────────────────
  app.get('/v1/usage', { preHandler: requireScope('usage:read') }, async (req) => {
    const caller = callerOf(req)
    const summary = await store.usageSummary(caller.userId)
    return { userId: caller.userId, ...summary, costUsd: formatUsd(summary.costMicroUsd) }
  })

  return app
}
