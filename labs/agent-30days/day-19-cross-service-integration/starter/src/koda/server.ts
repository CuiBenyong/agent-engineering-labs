/**
 * 被调用方（mini-koda）这一侧：验签、判 scope、提供 inject / memory / usage 三类接口。
 *
 * 全文只有一条安全不变量，但它管住了整个文件：
 *   身份只能来自 token 的 sub，绝不能来自请求体。
 * 请求体是调用方随便写的，token 是签过名的。
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { createRemoteJWKSet, decodeJwt } from 'jose'
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
  // 练习 2 要用它：jose 的远端公钥集合，会自己缓存、遇到没见过的 kid 会重新拉
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl))
  const app = Fastify({ logger: false })

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/health')) return
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return reply.code(401).send({ error: 'missing_token' })
    try {
      // 练习 2：下面这一行只是把载荷 base64 解开就信了——签名一眼没看、exp 一眼没看。
      //   任何人都能把 sub 改成别人的用户 id 再打过来，服务照单全收。
      // 要求：换成 jose 的 jwtVerify，用上面那个 jwks 验签，并校验 iss / aud（exp 由它自动校验）。
      // 提示：jwtVerify(token, jwks, { issuer, audience, algorithms: ['RS256'] })
      //       返回 { payload }；验不过会抛异常，正好落进下面的 catch 变成 401。
      void jwks
      const payload = decodeJwt(token)
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
      // 练习 3：这里直接放行了——一张只被授予 inject:write 的 token 现在也能查成本。
      // 要求：token 的 scopes 里没有这个 scope 就回 403（不是 401：身份是真的，只是没被授权），
      //       body 用 { error: 'insufficient_scope', required: scope }。
      // 提示：身份从 callerOf(req) 拿；在 preHandler 里 await reply.code(403).send(...) 就会中断这次请求。
      void scope
      void reply
      void callerOf(req)
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
    // 练习 5：下面这一行让请求体决定了「这条消息写进谁的会话」。
    //   调用方只要在 body 里写别人的 userId，就能把消息注入别人的会话——
    //   token 验得再严也白搭，因为身份根本不是从 token 里来的。
    // 要求：改成只认 caller.userId，请求体里的 userId 一律无视。
    // 提示：本文件里 GET /v1/usage 那个 handler 就是正确写法，照它改这里和下面的 memory。
    const userId = stringField(body, 'userId') || caller.userId

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
    // 练习 5（第二处）：同一个问题——写谁的记忆不能由请求体说了算
    const userId = stringField(body, 'userId') || caller.userId
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
