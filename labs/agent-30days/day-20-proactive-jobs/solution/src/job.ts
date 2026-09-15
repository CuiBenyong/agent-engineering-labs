import type { Clock } from './clock'
import { passGates, type UserProfile } from './gates'
import type { DeferredItem, Infra } from './infra/index'
import { deliver, type NotificationProvider, type Sleep } from './notify'

/** 一条待发的主动消息。prompt 交给模型去写正文，所以生成一条是要花钱的。 */
export type Candidate = {
  id: string
  userId: string
  kind: string
  prompt: string
  expiresAt?: string
}

// 本课统一价格口径：openai/gpt-4o-mini 输入 0.15、输出 0.60 美元每百万 token。
// 一条主动消息按输入 3000 / 输出 500 token 估，合 750 微美元（= 0.00075 美元），与 D13 同一笔账。
const PROMPT_TOKENS = 3000
const COMPLETION_TOKENS = 500
export const MICRO_USD_PER_MESSAGE = PROMPT_TOKENS * 0.15 + COMPLETION_TOKENS * 0.6

export type JobStats = {
  /** 进过闸的候选总数。它和 modelCalls 的差就是"闸放对位置"省下来的钱。 */
  evaluated: number
  sent: number
  deferred: number
  dropped: number
  modelCalls: number
}

export type JobContext = {
  infra: Infra
  provider: NotificationProvider
  profiles: Map<string, UserProfile>
  clock: Clock
  sleep?: Sleep
  stats: JobStats
  trace: (line: string) => void
}

export function emptyStats(): JobStats {
  return { evaluated: 0, sent: 0, deferred: 0, dropped: 0, modelCalls: 0 }
}

/** 已经调过模型却没能发出去的那些消息，折算成白花的钱。三道闸放对位置时这个数恒为 0。 */
export function wastedMicroUsd(stats: JobStats): number {
  return (stats.modelCalls - stats.sent) * MICRO_USD_PER_MESSAGE
}

/** 假如三道闸挪到生成之后：每一条候选都要先花一次模型调用的钱。 */
export function wastedIfGatesLastMicroUsd(stats: JobStats): number {
  return (stats.evaluated - stats.sent) * MICRO_USD_PER_MESSAGE
}

export function formatUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(6)}`
}

/**
 * 唯一的网络出口：让模型把这条主动消息的正文写出来。
 * MOCK=1 下返回固定文案，但**计数照记**——本天的重点就是"被闸拦下的消息有没有花掉这笔钱"。
 */
async function generate(ctx: JobContext, candidate: Candidate): Promise<string> {
  ctx.stats.modelCalls += 1
  if (process.env.MOCK === '1') {
    return `这是离线模拟正文（${candidate.kind}）：去掉 MOCK=1 并在 .env 里配置 OPENROUTER_API_KEY，就能连上真模型。`
  }
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: candidate.prompt }],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status}`)
  const data = (await res.json()) as { choices: { message: { content: string } }[] }
  return data.choices[0].message.content
}

function toCandidate(item: DeferredItem): Candidate {
  return {
    id: item.id,
    userId: item.userId,
    kind: item.kind,
    prompt: item.prompt,
    expiresAt: item.expiresAt,
  }
}

/**
 * 跑一轮主动关怀 Job：先把到期的延后项捞回来，再和新候选一起过三道闸。
 *
 * 顺序是本天的核心：**先过闸、再生成、最后投递**。
 * 把 passGates 挪到 generate 之后，程序照样跑得通、结果也一样，
 * 只是每一条被拦下的消息都白付了一次模型调用的钱。
 */
export async function runOnce(ctx: JobContext, fresh: Candidate[] = []): Promise<JobStats> {
  const at = ctx.clock.now()
  const revived = (await ctx.infra.store.popDue(at.getTime())).map(toCandidate)
  for (const candidate of [...revived, ...fresh]) {
    const profile = ctx.profiles.get(candidate.userId)
    if (!profile) continue
    ctx.stats.evaluated += 1

    const verdict = await passGates(ctx.infra.store, profile, candidate, at)

    if (verdict.action === 'defer' && verdict.dueAt) {
      await ctx.infra.store.pushDeferred({ ...candidate, dueAtMs: verdict.dueAt.getTime() })
      ctx.stats.deferred += 1
      ctx.trace(`[defer] ${candidate.id} → ${verdict.dueAt.toISOString()}（${verdict.reason}）`)
      continue
    }
    if (verdict.action === 'drop') {
      ctx.stats.dropped += 1
      ctx.trace(`[drop ] ${candidate.id}（${verdict.reason}）`)
      continue
    }

    const body = await generate(ctx, candidate)
    const notification = {
      idempotencyKey: `notify:${candidate.id}`,
      userId: candidate.userId,
      title: candidate.kind,
      body,
    }
    const outcome = await deliver(ctx.provider, notification, ctx.sleep)
    if (!outcome.ok) {
      // 渠道最终没收下：名额还回去，否则用户今天白丢一条额度
      await ctx.infra.store.releaseDaily(profile.id, verdict.localDate)
      ctx.stats.dropped += 1
      ctx.trace(`[fail ] ${candidate.id}（${outcome.detail}）`)
      continue
    }
    await ctx.infra.store.recordSend({
      id: candidate.id,
      userId: candidate.userId,
      channel: ctx.provider.id,
      idempotencyKey: notification.idempotencyKey,
      title: notification.title,
      body: notification.body,
      providerMessageId: outcome.detail,
      sentAtMs: at.getTime(),
    })
    ctx.stats.sent += 1
    ctx.trace(
      `[sent ] ${candidate.id} 经 ${ctx.provider.id}（${verdict.reason}，${outcome.attempts} 次尝试）`
    )
  }
  return ctx.stats
}
