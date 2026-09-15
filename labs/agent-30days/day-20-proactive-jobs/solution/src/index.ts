import 'dotenv/config'
import { FakeClock, systemClock, type Clock } from './clock'
import { isQuiet, localPartsOf, resolveLocal, type LocalParts, type UserProfile } from './gates'
import { createInfra, type Infra } from './infra/index'
import { createProvider, deliver, type Sleep } from './notify'
import {
  emptyStats,
  formatUsd,
  runOnce,
  wastedIfGatesLastMicroUsd,
  wastedMicroUsd,
  type Candidate,
  type JobContext,
} from './job'

/** 三个用户，三个时区，同一套安静时段与上限（本课固定口径：22:00–08:00、每天 3 条）。 */
const PROFILES = new Map<string, UserProfile>(
  (
    [
      ['u-sh', 'Asia/Shanghai'],
      ['u-ny', 'America/New_York'],
      ['u-ld', 'Europe/London'],
    ] as const
  ).map(([id, timeZone]) => [
    id,
    { id, timeZone, quietStart: '22:00', quietEnd: '08:00', dailyLimit: 3 },
  ])
)

const ITEMS: [string, string][] = [
  ['时区换算与夏令时判定', 'localPartsOf 还没按用户时区换算（练习 1）'],
  ['跨午夜的安静时段判断', 'isQuiet 的跨午夜分支还没写，22:00–08:00 恒为 false（练习 2）'],
  ['安静时段内推迟而不是丢弃', 'quietEndsAt 还没算出窗口结束时刻（练习 3）'],
  ['每日上限按用户本地日历日', 'passGates 的第三道闸还没判上限（练习 4）'],
  [
    '三道闸在投递前生效，零白花成本',
    '要么三道闸没拦住任何东西（练习 1–4），要么它被放到了 generate 之后（练习 5）',
  ],
  ['通知 provider 可替换且重试不重发', 'provider 抽象出问题了'],
]

const results: boolean[] = []

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/6] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

function parts(hhmm: string): LocalParts {
  const [hour, minute] = hhmm.split(':').map(Number)
  return { date: '2026-09-05', hour, minute }
}

/** 自检里的退避等待：不真的睡，直接推进假时钟，重试路径一毫秒验完。 */
function fakeSleep(clock: FakeClock): Sleep {
  return async (ms: number) => {
    clock.advance(ms)
  }
}

async function selfTest(infra: Infra): Promise<number> {
  const clock = new FakeClock('2026-09-05T23:30:00Z')
  const ctx: JobContext = {
    infra,
    provider: createProvider('inapp'),
    profiles: PROFILES,
    clock,
    sleep: fakeSleep(clock),
    stats: emptyStats(),
    trace: (line) => console.log(`      ${line}`),
  }

  // [1] 同一个 UTC 瞬时，三个时区给出三个不同的本地时间；夏令时那两天的裁定也要对
  const at = new Date('2026-09-05T23:30:00Z')
  const local = ['u-sh', 'u-ny', 'u-ld'].map((id) => {
    const p = localPartsOf(PROFILES.get(id)!.timeZone, at)
    return `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  })
  const gap = resolveLocal('America/New_York', '2026-03-08', '02:30')
  const amb = resolveLocal('America/New_York', '2026-11-01', '01:30')
  const ok1 =
    local[0] === '2026-09-06 07:30' &&
    local[1] === '2026-09-05 19:30' &&
    local[2] === '2026-09-06 00:30' &&
    gap.kind === 'gap' &&
    gap.instant.toISOString() === '2026-03-08T07:30:00.000Z' &&
    amb.kind === 'ambiguous' &&
    amb.instant.toISOString() === '2026-11-01T05:30:00.000Z'
  check(1, ok1, `sh/ny/ld = ${local.join(' | ')}；DST 判定 ${gap.kind}/${amb.kind}`)

  // [2] 22:00–08:00 跨了午夜：朴素的 start <= now && now < end 会让这一行全是 false
  const table: [string, boolean][] = [
    ['21:59', false],
    ['22:00', true],
    ['23:59', true],
    ['00:00', true],
    ['07:59', true],
    ['08:00', false],
    ['12:00', false],
  ]
  const sh = PROFILES.get('u-sh')!
  const got = table.map(([hhmm]) => isQuiet(sh, parts(hhmm)))
  const ok2 = table.every(([, want], i) => got[i] === want)
  check(2, ok2, table.map(([hhmm], i) => `${hhmm}=${got[i] ? '静' : '可发'}`).join(' '))

  // [3] 安静时段内的消息推迟到窗口结束；只有在那之前就过期的才丢弃
  const keep: Candidate = {
    id: 'c-defer',
    userId: 'u-sh',
    kind: '订单摘要',
    prompt: '汇总今天的订单',
  }
  const expiring: Candidate = {
    id: 'c-expire',
    userId: 'u-sh',
    kind: '限时提醒',
    prompt: '这单 30 分钟后自动取消',
    expiresAt: '2026-09-05T20:00:00Z',
  }
  await runOnce(ctx, [keep, expiring])
  clock.set('2026-09-06T00:00:00Z') // 用户本地 08:00，安静时段刚结束
  await runOnce(ctx)
  const sends = await infra.store.allSends()
  const revived = sends.find((s) => s.id === 'c-defer')
  const ok3 =
    ctx.stats.deferred === 1 &&
    revived !== undefined &&
    revived.sentAtMs === Date.parse('2026-09-06T00:00:00Z') &&
    !sends.some((s) => s.id === 'c-expire')
  check(
    3,
    ok3,
    `推迟 ${ctx.stats.deferred} 条；c-defer ${revived ? `于 ${new Date(revived.sentAtMs).toISOString()} 发出` : '没有发出'}；` +
      `已过期的 c-expire ${sends.some((s) => s.id === 'c-expire') ? '被发了出去' : '已丢弃'}`
  )

  // [4] 同一个用户当天第 4 条被拦下；跨过**用户本地**午夜之后额度重置
  clock.set('2026-09-05T19:00:00Z') // 纽约本地 15:00，不在安静时段
  const burst: Candidate[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `c-ny-${n}`,
    userId: 'u-ny',
    kind: '订单摘要',
    prompt: `第 ${n} 条`,
  }))
  await runOnce(ctx, burst)
  const day1 = (await infra.store.allSends()).filter((s) => s.userId === 'u-ny').length
  clock.set('2026-09-06T13:00:00Z') // 纽约本地次日 09:00
  await runOnce(ctx, [{ id: 'c-ny-6', userId: 'u-ny', kind: '订单摘要', prompt: '新的一天' }])
  const day2 = (await infra.store.allSends()).filter((s) => s.userId === 'u-ny').length - day1
  const ok4 = day1 === 3 && day2 === 1
  check(4, ok4, `本地 09-05 发出 ${day1} 条（上限 3），跨过本地午夜后 09-06 又能发 ${day2} 条`)

  // [5] 被拦下的消息一次模型调用都没有发生
  const wasted = wastedMicroUsd(ctx.stats)
  // 两个条件缺一不可：闸真的拦下了东西（evaluated 大于 sent），
  // 而且拦下的那些一次模型调用都没发生（modelCalls 等于 sent）。
  const ok5 =
    ctx.stats.evaluated > ctx.stats.sent && ctx.stats.modelCalls === ctx.stats.sent && wasted === 0
  check(
    5,
    ok5,
    `候选 ${ctx.stats.evaluated} 条 / 发出 ${ctx.stats.sent} 条 / 模型调用 ${ctx.stats.modelCalls} 次，白花 ${formatUsd(wasted)}` +
      `（闸若放在生成之后要白花 ${formatUsd(wastedIfGatesLastMicroUsd(ctx.stats))}）`
  )

  // [6] 换一个渠道，业务代码一行不改；限流重试带同一个幂等键，用户只收到一条
  const sms = createProvider('sms')
  const inapp = createProvider('inapp')
  const note = { idempotencyKey: 'notify:c-retry', userId: 'u-sh', title: '订单摘要', body: '正文' }
  const viaSms = await deliver(sms, note, fakeSleep(clock))
  const viaInApp = await deliver(inapp, note, fakeSleep(clock))
  const ok6 =
    viaSms.ok &&
    viaSms.attempts === 2 &&
    sms.inbox().length === 1 &&
    viaInApp.ok &&
    viaInApp.attempts === 1
  check(
    6,
    ok6,
    `sms 重试 ${viaSms.attempts} 次后成功、收件箱 ${sms.inbox().length} 条；inapp ${viaInApp.attempts} 次成功`
  )

  const passed = results.filter(Boolean).length
  console.log(`\n=== 自检结束：${passed}/${results.length} 项通过 ===`)
  return passed === results.length ? 0 : 1
}

/** 常驻模式的演示候选：每轮给三个用户各排一条，实际发不发由三道闸说了算。 */
function demoCandidates(clock: Clock): Candidate[] {
  const stamp = clock.now().toISOString().slice(0, 16)
  return [...PROFILES.keys()].map((userId) => ({
    id: `demo:${userId}:${stamp}`,
    userId,
    kind: '订单摘要',
    prompt: '汇总我今天的订单状态',
  }))
}

async function main(): Promise<void> {
  const infra = await createInfra()
  await infra.store.init()

  // D14 的口径：生产环境不允许跑内存实现，否则一次配置疏漏会让进程安静地在自己的内存里干活
  if ((process.env.APP_ENV ?? 'dev') === 'prod' && infra.mode !== 'real') {
    throw new Error('生产环境不允许跑内存实现（缺 REDIS_URL / DATABASE_URL）')
  }

  if (process.env.SELFTEST === '1') {
    console.log(`=== D20 自检开始（基础设施：${infra.mode}）===`)
    process.exitCode = await selfTest(infra)
    await infra.store.close()
    return
  }

  const ctx: JobContext = {
    infra,
    provider: createProvider(),
    profiles: PROFILES,
    clock: systemClock,
    stats: emptyStats(),
    trace: (line) => console.log(line),
  }
  console.log(
    `[job] 常驻模式启动（基础设施：${infra.mode}，渠道：${ctx.provider.id}），每分钟跑一轮，Ctrl-C 退出`
  )

  // D14 的优雅停机口径：拒绝新一轮 → 等手头这轮跑完 → 退出
  let draining = false
  process.on('SIGTERM', () => {
    draining = true
  })
  process.on('SIGINT', () => {
    draining = true
  })
  while (!draining) {
    await runOnce(ctx, demoCandidates(ctx.clock))
    console.log(
      `[job] 本轮累计：发出 ${ctx.stats.sent} / 推迟 ${ctx.stats.deferred} / 拦下 ${ctx.stats.dropped}`
    )
    await new Promise((resolve) => setTimeout(resolve, 60_000 - (Date.now() % 60_000)))
  }
  console.log('[job] 收到停止信号，本轮已跑完，退出')
  await infra.store.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
