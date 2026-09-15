import { randomUUID } from 'node:crypto'
import type { Infra } from './infra/index'
import { costMicroUsd, formatUsd } from './ledger'

export const STREAM = 'koda:runs'
export const GROUP = 'workers'
export const CHAT_MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini'
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small'

const API_BASE = 'https://openrouter.ai/api/v1'

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

// ——— 唯一的两个网络出口。MOCK=1 时下面的真实请求一行都不执行 ———
type ChatResult = { text: string; promptTokens: number; completionTokens: number }

async function chat(input: string): Promise<ChatResult> {
  if (process.env.MOCK === '1') {
    // token 数固定是故意的，自检要能手算出预期金额：1200 × 0.15 + 240 × 0.60 = 324 微美元
    return {
      text: `离线模拟回复：已处理「${input}」。去掉 MOCK=1 并配置 OPENROUTER_API_KEY 可连真模型。`,
      promptTokens: 1200,
      completionTokens: 240,
    }
  }
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: '你是电商平台的售后助手，回答不超过 3 句话。' },
        { role: 'user', content: input },
      ],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败 HTTP ${res.status}`)
  const json = (await res.json()) as {
    choices: { message: { content: string } }[]
    usage: { prompt_tokens: number; completion_tokens: number }
  }
  // 记账要读厂商返回的 usage，不要自己再估一遍——估算只用于压缩阈值那类场景
  return {
    text: json.choices[0].message.content,
    promptTokens: json.usage.prompt_tokens,
    completionTokens: json.usage.completion_tokens,
  }
}

/** D12 的记忆写入。今天只关心它花了多少 token，向量本身交给 D12 的实验去存。 */
async function embed(text: string): Promise<number> {
  // D12 的 chunk 目标是 400 字符，按本课「1 个字符按 1 个 token 保守估」的口径
  if (process.env.MOCK === '1') return 400
  const res = await fetch(`${API_BASE}/embeddings`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 400) }),
  })
  if (!res.ok) throw new Error(`embedding 调用失败 HTTP ${res.status}`)
  return ((await res.json()) as { usage: { prompt_tokens: number } }).usage.prompt_tokens
}

// ——— 记账与消费循环 ———
/** 记一笔台账，返回这笔的金额（微美元）。chat 与 embedding 走同一条路径。 */
async function record(
  infra: Infra,
  ctx: { userId: string; runId: string; createdAt: string },
  model: string,
  kind: 'chat' | 'embedding',
  promptTokens: number,
  completionTokens: number
): Promise<number> {
  const micro = costMicroUsd(model, promptTokens, completionTokens)
  const entry = { model, kind, promptTokens, completionTokens, costMicroUsd: micro }
  await infra.store.insertUsage({ ...ctx, ...entry, id: randomUUID() })
  return micro
}

export type ConsumeResult = { read: number; executed: number; skipped: number }

/**
 * 消费一批消息：落 run（幂等）→ 调模型 → 记两笔台账 → 收尾 → ack。
 * 被幂等键挡下的直接 ack 不执行，这就是「同一个 cron tick 只被消费一次」的全部实现。
 */
export async function consumeOnce(
  infra: Infra,
  consumer: string,
  count = 2
): Promise<ConsumeResult> {
  const messages = await infra.bus.readGroup(STREAM, GROUP, consumer, count)
  let executed = 0
  let skipped = 0

  for (const message of messages) {
    const key = message.fields.idempotencyKey ?? ''
    const userId = message.fields.userId ?? 'unknown'
    const input = message.fields.input ?? ''
    // 同一个幂等键必须推出同一个 run id，否则唯一约束挡住了、主键却又冲不上
    const runId = `run-${key.replace(/[^a-zA-Z0-9]+/g, '_')}`

    const sessionId = `cron:${message.fields.taskId ?? 'unknown'}`
    const fresh = await infra.store.insertRun({ id: runId, sessionId, userId, key, input })
    if (!fresh) {
      // D8 那条 runs.idempotency_key 唯一约束挡住了：这一分钟的这个任务已经建过 run
      console.log(`[${consumer}] 跳过重复投递 ${key}`)
      await infra.bus.ack(STREAM, GROUP, [message.id])
      skipped += 1
      continue
    }

    const ctx = { userId, runId, createdAt: new Date().toISOString() }
    const reply = await chat(input)
    const chatMicro = await record(
      infra,
      ctx,
      CHAT_MODEL,
      'chat',
      reply.promptTokens,
      reply.completionTokens
    )
    // D12 留下的那笔新开销：每写一条记忆就要调一次 embedding，今天它也进台账
    const embedMicro = await record(
      infra,
      ctx,
      EMBEDDING_MODEL,
      'embedding',
      await embed(reply.text),
      0
    )

    await infra.store.finishRun(runId, reply.promptTokens, reply.completionTokens)
    await infra.bus.ack(STREAM, GROUP, [message.id])
    executed += 1
    console.log(
      `[${consumer}] 执行 ${key} → chat ${formatUsd(chatMicro)} + embedding ${formatUsd(embedMicro)}`
    )
  }

  return { read: messages.length, executed, skipped }
}

/** 常驻消费循环，供 `pnpm start:worker` 与真实部署使用。 */
export async function runWorker(infra: Infra, consumer: string): Promise<void> {
  console.log(`Worker ${consumer} 已就绪，等待 ${STREAM} 上的任务……`)
  for (;;) {
    const result = await consumeOnce(infra, consumer)
    if (result.read === 0) await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
