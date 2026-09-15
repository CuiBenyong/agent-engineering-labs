import type { Bus } from './infra/bus.js'
import type { Store } from './infra/store.js'
import { sleep } from './shared/net.js'
import {
  GROUP,
  RUNS_STREAM,
  outStream,
  rerunKey,
  transition,
  type Run,
  type RunStatus,
} from './shared/run.js'

const MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini'

/**
 * 唯一的网络出口：模型调用。MOCK=1 时整段真实请求一行都不执行。
 * 假回复里回显了输入，这样打断合并之后你能一眼看出「第二段用的是合并后的输入」。
 */
async function* streamChat(input: string): AsyncGenerator<string> {
  if (process.env.MOCK === '1') {
    const canned = `已收到「${input.replace(/\n/g, ' + ')}」，正在按 seq 逐片回传。`
    for (const ch of canned) {
      await sleep(10)
      yield ch
    }
    return
  }
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: input }],
      stream: true,
    }),
  })
  if (!res.ok || !res.body) throw new Error(`上游返回 HTTP ${res.status}`)
  // 逐块读、按行切、半行留到下一轮——D1 讲过的客户端解析逻辑，这里原样复用
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return
      const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
      const delta = parsed.choices?.[0]?.delta?.content
      if (delta) yield delta
    }
  }
}

interface PassResult {
  seq: number
  status: RunStatus
  interrupted: boolean
}

export function startWorker(bus: Bus, store: Store, id: string): { stop: () => Promise<void> } {
  let running = true

  /**
   * 生成一遍。seq 由调用方传入并**只增不减**：
   * 打断合并会让同一个 run 跑第二遍，但编号必须接着往下走，
   * 否则重连时按 Last-Event-ID 续号会续到一段已经作废的历史上。
   */
  async function generate(run: Run, startSeq: number, status: RunStatus): Promise<PassResult> {
    const out = outStream(run.id)
    let seq = startSeq
    let current = status
    let held: { seq: number; text: string } | null = null
    const flush = async (): Promise<void> => {
      if (!held) return
      await bus.publish(out, { seq: String(held.seq), text: held.text })
      held = null
    }

    for await (const chunk of streamChat(run.input)) {
      if (current === 'running') {
        current = transition(current, 'streaming')
        await store.setStatus(run.id, current)
      }
      // 双写：库里一行（unique(run_id, seq) 天然去重），流上一条。
      // 流是给「现在正挂着的连接」用的，库是给「等一下才回来的人」用的。
      await store.insertDelta({
        id: `${run.id}:${seq}`,
        sessionId: run.sessionId,
        runId: run.id,
        seq,
        content: chunk,
      })
      // 错序注入：真实系统里同一条输出流上可能有多个并发写入者（模型片段、工具事件、
      // 状态通知），XADD 的到达顺序不等于 seq 顺序。这里每 5 个片段故意把相邻两条调换，
      // 好让「gateway 必须按 seq 排序」这件事能被自检稳定验证到——真实 worker 没有这段。
      if (held) {
        await bus.publish(out, { seq: String(seq), text: chunk })
        await flush()
      } else if (seq % 5 === 4) {
        held = { seq, text: chunk }
      } else {
        await bus.publish(out, { seq: String(seq), text: chunk })
      }
      seq += 1
      if (await bus.flagGet(rerunKey(run.id))) {
        await flush()
        return { seq, status: current, interrupted: true }
      }
    }
    await flush()
    return { seq, status: current, interrupted: false }
  }

  async function handle(runId: string): Promise<void> {
    const first = await store.getRun(runId)
    if (!first) return
    // 至少一次投递（D9）下重复消费是常态：只有 pending 的 run 才需要执行
    if (first.status !== 'pending') return
    let status = transition(first.status, 'running')
    await store.setStatus(runId, status)
    let seq = 0
    try {
      for (;;) {
        // 先清标记再读 input：顺序反了会漏掉「清标记那一瞬间刚追加进来」的消息
        await bus.flagClear(rerunKey(runId))
        const run = await store.getRun(runId)
        if (!run) return
        const pass = await generate(run, seq, status)
        seq = pass.seq
        status = pass.status
        if (!pass.interrupted) break
        console.log(`[worker ${id}] run 被打断合并，带合并后的输入重跑，seq 从 ${seq} 继续`)
      }
      await store.setStatus(runId, transition(status, 'done'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await store.setStatus(runId, transition(status, 'failed'), message)
    }
  }

  const loop = (async (): Promise<void> => {
    await bus.ensureGroup(RUNS_STREAM, GROUP)
    while (running) {
      const batch = await bus.readGroup(RUNS_STREAM, GROUP, id, 4)
      if (batch.length === 0) {
        await sleep(20)
        continue
      }
      for (const message of batch) {
        await handle(message.fields.runId ?? '')
        await bus.ack(RUNS_STREAM, GROUP, [message.id])
      }
    }
  })()

  return {
    stop: async (): Promise<void> => {
      running = false
      await loop
    },
  }
}
