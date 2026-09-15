import 'dotenv/config'
import { decodeJwt } from 'jose'
import { createIssuer, TOKEN_TTL_SECONDS } from './agent/issuer'
import { createKodaClient } from './agent/client'
import { type Store, createStore } from './infra/index'
import { createKodaServer } from './koda/server'
import { type UsageRow, formatUsd } from './shared/types'

const KODA_PORT = Number(process.env.KODA_PORT ?? 3019)
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 4019)
const KODA_URL = `http://127.0.0.1:${KODA_PORT}`

const results: boolean[] = []

// 九项自检的标题与失败提示，提示直接点名 starter 里对应的练习点
const ITEMS: [string, string][] = [
  ['JWKS 只发公钥', 'JWKS 里出现了私钥参数'],
  ['token 的 claims 与有效期', 'mint 还没按口径铸造（练习 1）'],
  ['合法 token 能调通 inject', 'inject 没有落库'],
  ['篡改过的 token 被拒', '验签还是 base64 解码（练习 2）'],
  ['过期 token 被拒', 'token 没带 exp、验签也没校验它（练习 1 + 练习 2）'],
  ['scope 不足被拒', 'requireScope 直接放行了（练习 3）'],
  ['同一 externalId 只产生一条记录', '幂等键没加命名空间、或插入结果被忽略（练习 4）'],
  ['身份只来自 token', 'handler 还在信请求体里的 userId（练习 5）'],
  ['usage 只汇总自己的账', '汇总口径不对'],
]

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/9] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

/** 台账种子数据。单价来自本课统一口径：输入 $0.15/1M、输出 $0.60/1M、embedding $0.02/1M。 */
function seedRows(): UsageRow[] {
  const chat = (id: string, userId: string): UsageRow => ({
    id,
    userId,
    runId: `r-${id}`,
    model: 'openai/gpt-4o-mini',
    kind: 'chat',
    promptTokens: 1200,
    completionTokens: 300,
    costMicroUsd: 360, // 1200×0.15 + 300×0.60，单位微美元
    createdAt: new Date().toISOString(),
  })
  return [
    chat('l-1', 'u-1'),
    chat('l-2', 'u-1'),
    {
      id: 'l-3',
      userId: 'u-1',
      runId: 'r-l-1',
      model: 'openai/text-embedding-3-small',
      kind: 'embedding',
      promptTokens: 400,
      completionTokens: 0,
      costMicroUsd: 8, // 400×0.02
      createdAt: new Date().toISOString(),
    },
    chat('l-4', 'u-2'),
  ]
}

/** 篡改：把载荷换成另一个用户，签名原样保留——这正是「base64 不是加密」的现场演示。 */
function tamper(token: string): string {
  const [header, , signature] = token.split('.')
  const forged = { ...decodeJwt(token), sub: 'u-victim' }
  const payload = Buffer.from(JSON.stringify(forged)).toString('base64url')
  return [header, payload, signature].join('.')
}

async function selfTest(store: Store): Promise<number> {
  const issuer = await createIssuer(AGENT_PORT)
  await issuer.listen()
  const koda = createKodaServer({
    store,
    port: KODA_PORT,
    issuerUrl: issuer.issuerUrl,
    jwksUrl: issuer.jwksUrl,
  })
  await koda.listen({ port: KODA_PORT, host: '127.0.0.1' })

  try {
    const jwk = issuer.publicJwks().keys[0] ?? {}
    const fields = Object.keys(jwk).sort()
    const ok1 = 'n' in jwk && 'kid' in jwk && !('d' in jwk)
    check(1, ok1, `JWKS 里的字段是 ${fields.join(',')}`)

    const all = await issuer.mint('u-1', [
      'inject:write',
      'memory:read',
      'memory:write',
      'usage:read',
    ])
    const claims = decodeJwt(all)
    const names = Object.keys(claims).sort().join(',')
    const ttl = Number(claims.exp ?? 0) - Number(claims.iat ?? 0)
    const ok2 = names === 'aud,exp,iat,iss,jti,scope,sub' && ttl === TOKEN_TTL_SECONDS
    check(2, ok2, `claims 是 ${names}，有效期 ${ttl} 秒（期望 900）`)

    const client = createKodaClient(KODA_URL, all)
    const first = await client.inject('evt-1', '我的订单到哪了')
    const events1 = await store.countExternalEvents()
    const ok3 = first.status === 201 && events1 === 1
    check(3, ok3, `第一次 inject 返回 ${first.status}，external_events 有 ${events1} 条`)

    const forged = await createKodaClient(KODA_URL, tamper(all)).inject('evt-x', '越权试试')
    const ok4 = forged.status === 401
    check(4, ok4, `换掉 sub 再打过来，返回 ${forged.status}（期望 401）`)

    const expired = await issuer.mint('u-1', ['inject:write'], -60)
    const expiredRes = await createKodaClient(KODA_URL, expired).inject('evt-y', '过期了')
    const ok5 = expiredRes.status === 401
    check(5, ok5, `一分钟前就过期的 token，返回 ${expiredRes.status}（期望 401）`)

    const injectOnly = createKodaClient(KODA_URL, await issuer.mint('u-1', ['inject:write']))
    const denied = await injectOnly.usage()
    const ok6 = denied.status === 403
    check(6, ok6, `只有 inject:write 的 token 去查 usage，返回 ${denied.status}（期望 403）`)

    const again = await client.inject('evt-1', '我的订单到哪了')
    const u2 = createKodaClient(KODA_URL, await issuer.mint('u-2', ['inject:write']))
    const cross = await u2.inject('evt-1', '换个人用同一个 externalId')
    const events2 = await store.countExternalEvents()
    const ok7 =
      again.status === 200 &&
      again.body.status === 'duplicate' &&
      cross.status === 201 &&
      events2 === 2
    check(
      7,
      ok7,
      `重复投递返回 ${again.status}/${String(again.body.status)}，另一个用户的同名 externalId 返回 ${cross.status}，累计 ${events2} 条（期望 200/duplicate、201、2）`
    )

    const spoof = await client.writeMemory('喜欢靠窗的座位', { userId: 'u-victim' })
    const victim = createKodaClient(KODA_URL, await issuer.mint('u-victim', ['memory:read']))
    const victimRows = (await victim.listMemory()).body.memories
    const mine = (await client.listMemory()).body.memories
    const ok8 =
      spoof.status === 201 &&
      Array.isArray(victimRows) &&
      victimRows.length === 0 &&
      Array.isArray(mine) &&
      mine.length === 1
    check(
      8,
      ok8,
      `请求体里写 userId=u-victim，结果 u-victim 读到 ${Array.isArray(victimRows) ? victimRows.length : '?'} 条、u-1 读到 ${Array.isArray(mine) ? mine.length : '?'} 条（期望 0 和 1）`
    )

    const usage = (await client.usage()).body
    const ok9 = usage.calls === 3 && usage.costMicroUsd === 728
    check(
      9,
      ok9,
      `u-1 名下 ${String(usage.calls)} 次调用、合计 ${String(usage.costUsd)}（期望 3 次、$0.000728）`
    )

    const passed = results.filter(Boolean).length
    console.log(`\n=== 自检结束：${passed}/${results.length} 项通过 ===`)
    return passed === results.length ? 0 : 1
  } finally {
    await koda.close()
    await issuer.close()
  }
}

async function main(): Promise<void> {
  const { store, mode } = await createStore()
  await store.init()
  if (process.env.SELFTEST === '1') await store.reset() // 真库下反复跑同一条命令也要得到同样的结果
  for (const row of seedRows()) await store.insertUsage(row)

  if (process.env.SELFTEST === '1') {
    console.log(`=== D19 自检开始（存储：${mode}）===`)
    process.exitCode = await selfTest(store)
    await store.close()
    return
  }

  // 常驻模式：两个服务都起来，打印一张现成的 token 供手动 curl
  const issuer = await createIssuer(AGENT_PORT)
  await issuer.listen()
  const koda = createKodaServer({
    store,
    port: KODA_PORT,
    issuerUrl: issuer.issuerUrl,
    jwksUrl: issuer.jwksUrl,
  })
  await koda.listen({ port: KODA_PORT, host: '127.0.0.1' })
  const token = await issuer.mint('u-1', [
    'inject:write',
    'memory:read',
    'memory:write',
    'usage:read',
  ])
  console.log(`调用方（发 token）：${issuer.jwksUrl}`)
  console.log(`被调用方（收请求）：${KODA_URL}   存储：${mode}`)
  console.log(
    `u-1 的 token（${TOKEN_TTL_SECONDS} 秒后过期，台账种子合计 ${formatUsd(728)}）：\n${token}\n`
  )
  console.log(`curl -s ${KODA_URL}/v1/usage -H "Authorization: Bearer $TOKEN"`)
  console.log(
    `curl -s ${KODA_URL}/v1/inject -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"externalId":"evt-1","text":"我的订单到哪了"}'`
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
