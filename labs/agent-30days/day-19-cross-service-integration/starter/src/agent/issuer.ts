/**
 * 调用方（某多 Agent 编排服务）这一侧：持有私钥、铸造用户级 JWT、对外发布 JWKS。
 *
 * 三条硬约定：RS256；exp 15 分钟；claims 只放 sub / iss / aud / scope / jti。
 * 私钥永远不出这个进程，对外只发公钥——JWKS 端点返回的 JWK 里绝不能出现私钥参数 d。
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'
import type { Scope } from '../shared/types'

export const AUDIENCE = 'mini-koda'
export const TOKEN_TTL_SECONDS = 900 // 15 分钟：够跑完一次跨服务调用，泄露了也很快作废

export interface Issuer {
  issuerUrl: string
  jwksUrl: string
  publicJwks(): { keys: JWK[] }
  mint(userId: string, scopes: Scope[], ttlSeconds?: number): Promise<string>
  listen(): Promise<void>
  close(): Promise<void>
}

export async function createIssuer(port: number): Promise<Issuer> {
  const issuerUrl = `http://127.0.0.1:${port}`
  // kid 是这把钥匙的名字。轮换时新旧两把公钥同时挂在 JWKS 里，验签方按 kid 挑，
  // 老 token 自然过期，两边都不用停机。
  const kid = 'agent-key-1'
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, use: 'sig', alg: 'RS256' }

  const app: FastifyInstance = Fastify({ logger: false })
  app.get('/.well-known/jwks.json', async () => ({ keys: [publicJwk] }))

  return {
    issuerUrl,
    jwksUrl: `${issuerUrl}/.well-known/jwks.json`,
    publicJwks: () => ({ keys: [publicJwk] }),

    async mint(userId, scopes, ttlSeconds = TOKEN_TTL_SECONDS) {
      // 练习 1：这张 token 少了三样东西——scope、jti，以及最要命的 exp。
      //   没有 exp 的 token 一旦泄露就是永久有效，签发方连作废它的手段都没有。
      // 要求：claims 恰好是 sub / iss / aud / scope / jti 五个（加上 iat、exp），
      //       有效期用参数 ttlSeconds（默认 TOKEN_TTL_SECONDS，也就是 15 分钟）。
      // 提示：SignJWT 有 setSubject / setIssuer / setAudience / setJti /
      //       setIssuedAt / setExpirationTime；exp 传「当前秒数 + ttlSeconds」。
      //       scope 是一个空格分隔的字符串，不是数组。
      //       别顺手把用户名、会员等级塞进去——JWT 是 base64，不是加密。
      void scopes
      void ttlSeconds
      return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid })
        .setSubject(userId)
        .setIssuer(issuerUrl)
        .setAudience(AUDIENCE)
        .sign(privateKey)
    },

    async listen() {
      await app.listen({ port, host: '127.0.0.1' })
    },
    async close() {
      await app.close()
    },
  }
}
