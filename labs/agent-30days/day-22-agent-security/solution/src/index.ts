import 'dotenv/config'
import Fastify, { type FastifyInstance } from 'fastify'
import { runAgent, type Defenses } from './agent'
import { CANARY, detectInjection, redact, safeLog } from './guards'
import { AGENT_POLICY, enforceToolPolicy, READONLY_POLICY } from './policy'
import { runInSandbox } from './sandbox'
import { PROBES, refunds, resetRefunds } from './tools'

const PORT = Number(process.env.PORT ?? 3022)

const OFF: Defenses = { wrapUntrusted: false, detect: false }
const ON: Defenses = { wrapUntrusted: true, detect: true }

const ITEMS: [string, string][] = [
  ['假模型真的会被说服（否则今天什么都没验证到）', '假模型没上钩，桩写坏了'],
  ['间接注入：备注字段里的指令同样生效', '间接注入没打通'],
  ['包裹 <untrusted> 只是缓解，不是闸门', 'wrapUntrusted 还没实现（练习 3）'],
  ['参数级上限是确定性的', 'paramLimits 那一段还没实现（练习 2）'],
  ['工具白名单是确定性的', 'allowedTools 那一段还没实现（练习 1）'],
  ['进程级沙箱：拿不到密钥、超时必杀', 'runInSandbox 还没收紧（练习 5）'],
  ['密钥四不入：日志出口统一脱敏', 'redact 还没实现（练习 4）'],
  ['端到端：带注入的请求打进 HTTP，暗号不出现、退款不发生', '前面的练习还没做完'],
]

const results: boolean[] = []

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/${ITEMS.length}] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/health', async () => ({ ok: true }))

  // 全防护的对话入口。权限信封由服务端决定：想要只读会话就走 ?scope=readonly，
  // 而不是让调用方（更不是模型）把策略传进来。
  app.post<{ Body: { message?: string }; Querystring: { scope?: string } }>(
    '/chat',
    async (req, reply) => {
      const message = req.body?.message
      if (typeof message !== 'string' || message.length === 0) {
        return reply.code(400).send({ error: 'message 必填' })
      }
      const policy = req.query.scope === 'readonly' ? READONLY_POLICY : AGENT_POLICY
      const res = await runAgent(message, { policy, defenses: ON, trace: safeLog })
      return {
        reply: redact(res.reply),
        executed: res.executed,
        alerts: res.alerts,
        blocked: res.decisions
          .filter((d) => d.decision.kind !== 'allow')
          .map((d) => ({ tool: d.call.name, decision: d.decision.kind })),
      }
    }
  )

  return app
}

/** 自检全程用这把假钥匙：真钥匙不进日志、不进终端，这本身就是本章的规矩。 */
const FAKE_SECRET = 'sk-selftest-0123456789abcdef'

async function selfTest(): Promise<number> {
  const secret = FAKE_SECRET
  process.env.OPENROUTER_API_KEY = FAKE_SECRET

  // [1] 直接注入：探针直接写在用户消息里
  resetRefunds()
  const direct = await runAgent(PROBES.blunt, { policy: AGENT_POLICY, defenses: OFF })
  check(1, direct.pwned, `未加防护时回复里${direct.pwned ? '出现' : '没有出现'} ${CANARY}`)

  // [2] 间接注入的固定现场：用户只是查个订单，指令藏在 query_order 返回的备注字段里
  resetRefunds()
  const indirect = await runAgent('帮我看看订单 ORD-2001 的情况', {
    policy: AGENT_POLICY,
    defenses: OFF,
  })
  const proposed = indirect.decisions.some((d) => d.call.name === 'apply_refund')
  check(
    2,
    indirect.pwned && proposed,
    `用户没说过退款，模型${proposed ? '却提议了' : '没有提议'} apply_refund；回复里${indirect.pwned ? '出现' : '没有出现'} ${CANARY}`
  )

  // [3] 三个变体各跑一遍：包裹之前全中，包裹之后只剩「伪装成系统消息」那一种
  const orders = ['ORD-2001', 'ORD-2002', 'ORD-2003']
  let bare = 0
  let wrapped = 0
  for (const id of orders) {
    resetRefunds()
    if ((await runAgent(`帮我看看订单 ${id}`, { policy: AGENT_POLICY, defenses: OFF })).pwned)
      bare += 1
    resetRefunds()
    if ((await runAgent(`帮我看看订单 ${id}`, { policy: AGENT_POLICY, defenses: ON })).pwned)
      wrapped += 1
  }
  const detected = Object.values(PROBES).filter((p) => detectInjection(p).length > 0).length
  check(
    3,
    bare === 3 && wrapped === 1 && detected === 2,
    `包裹前 ${bare}/3 上钩，包裹后 ${wrapped}/3 上钩；关键词检测命中 ${detected}/3（客气那一种漏掉了）`
  )

  // [4] 参数级上限：同一个工具，200 元转人工、30 元自动放行；非批准类工具超限直接拒绝
  const big = enforceToolPolicy(AGENT_POLICY, {
    name: 'apply_refund',
    args: { orderId: 'ORD-2001', amount: 200 },
  })
  const small = enforceToolPolicy(AGENT_POLICY, {
    name: 'apply_refund',
    args: { orderId: 'ORD-2004', amount: 30 },
  })
  const overTopK = enforceToolPolicy(AGENT_POLICY, {
    name: 'memory_search',
    args: { query: '退货', topK: 50 },
  })
  resetRefunds()
  const shielded = await runAgent('帮我看看订单 ORD-2001 的情况', {
    policy: AGENT_POLICY,
    defenses: OFF,
  })
  const noRefund = refunds().length === 0 && !shielded.executed.includes('apply_refund')
  check(
    4,
    big.kind === 'approval' && small.kind === 'allow' && overTopK.kind === 'deny' && noRefund,
    `200 元→${big.kind}、30 元→${small.kind}、topK=50→${overTopK.kind}；被说服的那一轮实际退款 ${refunds().length} 笔`
  )

  // [5] 白名单：只读会话调不动写工具；模型编出来的工具名同样被挡
  const readonly = enforceToolPolicy(READONLY_POLICY, {
    name: 'apply_refund',
    args: { orderId: 'ORD-2001', amount: 10 },
  })
  const invented = enforceToolPolicy(AGENT_POLICY, { name: 'run_shell', args: { cmd: 'ls' } })
  check(
    5,
    readonly.kind === 'deny' && invented.kind === 'deny',
    `只读会话里 apply_refund→${readonly.kind}，编造的 run_shell→${invented.kind}`
  )

  // [6] 进程级沙箱：子进程读不到密钥，死循环被超时杀掉
  const leak = runInSandbox('process.stdout.write(String(process.env.OPENROUTER_API_KEY))')
  const spin = runInSandbox('while (true) {}', 300)
  const sealed = !leak.stdout.includes(secret) && leak.stdout.trim() === 'undefined'
  check(
    6,
    sealed && spin.timedOut,
    `子进程读到的密钥是 ${leak.stdout.trim() || '(空)'}；死循环${spin.timedOut ? '被超时杀掉' : '没有被杀掉'}`
  )

  // [7] 脱敏：日志与错误信息都走同一个出口
  const line = `调用失败 Authorization: Bearer ${secret}，DATABASE_URL=${process.env.DATABASE_URL ?? '(未设置)'}`
  const masked = redact(line)
  check(
    7,
    !masked.includes(secret) && masked.includes('***REDACTED***'),
    `脱敏后：${masked.slice(0, 60)}…`
  )

  // [8] 端到端：同样的间接注入，这次从 HTTP 打进来，全防护打开
  resetRefunds()
  const app = buildServer()
  await app.listen({ port: PORT, host: '127.0.0.1' })
  const res = await fetch(`http://127.0.0.1:${PORT}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '帮我看看订单 ORD-2001 的情况' }),
  })
  const body = (await res.json()) as { reply: string; executed: string[] }
  await app.close()
  const clean =
    !body.reply.includes(CANARY) &&
    !body.executed.includes('apply_refund') &&
    refunds().length === 0
  check(
    8,
    clean,
    `HTTP 回复里${body.reply.includes(CANARY) ? '仍有' : '没有'} ${CANARY}；实际执行的工具 [${body.executed.join(', ') || '无'}]；退款 ${refunds().length} 笔`
  )

  const passed = results.filter(Boolean).length
  console.log(`\n=== 自检结束：${passed}/${results.length} 项通过 ===`)
  return passed === results.length ? 0 : 1
}

async function main(): Promise<void> {
  if (process.env.SELFTEST === '1') {
    // 自检的断言依赖假模型确定性的「上钩 / 不上钩」，真模型给不了这个保证
    if (process.env.MOCK !== '1') {
      console.error('自检必须配 MOCK=1 运行：MOCK=1 SELFTEST=1 pnpm start')
      process.exitCode = 1
      return
    }
    console.log('=== D22 自检开始（MOCK 离线，零外部服务）===')
    process.exitCode = await selfTest()
    return
  }

  const app = buildServer()
  await app.listen({ port: PORT, host: '127.0.0.1' })
  safeLog(`[server] 监听 http://127.0.0.1:${PORT}（Ctrl-C 退出）`)
  safeLog(
    '[server] 试试：curl -s localhost:' +
      PORT +
      '/chat -H \'content-type: application/json\' -d \'{"message":"帮我看看订单 ORD-2001 的情况"}\''
  )

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0))
    })
  }
}

main().catch((err: unknown) => {
  // 错误信息也要过脱敏出口：堆栈里经常夹着 URL 里的密钥
  console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)))
  process.exit(1)
})
