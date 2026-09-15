import 'dotenv/config'
import { createGateway } from './gateway.js'
import { createBus } from './infra/bus.js'
import { createStore, type Store } from './infra/store.js'
import { sleep } from './shared/net.js'
import { GROUP, RUNS_STREAM, canTransition } from './shared/run.js'
import { startWorker } from './worker.js'

const PORT = Number(process.env.PORT ?? 3011)
const HOST = process.env.HOST ?? '0.0.0.0'

interface StreamResult {
  seqs: number[]
  text: string
  lastEvent: string
  lastId: string
}

/**
 * 迷你 SSE 客户端（只在自检里用）：把响应体解析成一帧一帧的事件。
 * stopAfter 用来模拟「用户读到一半关掉页面」——读够片段就直接掐断连接。
 */
async function streamRun(
  base: string,
  runId: string,
  opts: { lastEventId?: string; stopAfter?: number } = {}
): Promise<StreamResult> {
  const controller = new AbortController()
  const headers: Record<string, string> = {}
  if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = opts.lastEventId
  const res = await fetch(`${base}/runs/${runId}/stream`, { headers, signal: controller.signal })
  const seqs: number[] = []
  const parts: string[] = []
  let lastEvent = '(无)'
  let frame: { id?: string; event?: string; data?: string } = {}
  const reader = res.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (; reader;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('id: ')) frame.id = line.slice(4)
        else if (line.startsWith('event: ')) frame.event = line.slice(7)
        else if (line.startsWith('data: ')) frame.data = line.slice(6)
        else if (line === '' && frame.event) {
          lastEvent = frame.event
          if (frame.event === 'delta') {
            seqs.push(Number(frame.id))
            parts.push((JSON.parse(frame.data ?? '{}') as { text: string }).text)
          }
          frame = {}
        }
      }
      if (opts.stopAfter !== undefined && seqs.length >= opts.stopAfter) {
        controller.abort()
        break
      }
    }
  } catch {
    // 主动 abort 会以异常形式结束读取，这正是我们要模拟的场景
  }
  return { seqs, text: parts.join(''), lastEvent, lastId: String(seqs.at(-1) ?? 0) }
}

async function postChat(
  base: string,
  sessionId: string,
  message: string
): Promise<{ runId: string; merged: boolean }> {
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  })
  return (await res.json()) as { runId: string; merged: boolean }
}

const isSequential = (seqs: number[]): boolean => seqs.every((s, i) => s === i)

async function selfTest(base: string, store: Store): Promise<boolean> {
  const results: boolean[] = []
  const report = (label: string, ok: boolean, detail: string): void => {
    results.push(ok)
    console.log(`${label} ${ok ? '✅' : '❌'} ${detail}`)
  }

  // 1. 状态机：合法转换放行、非法转换被拒
  const legal =
    canTransition('pending', 'running') &&
    canTransition('running', 'streaming') &&
    canTransition('streaming', 'done')
  const illegal =
    !canTransition('done', 'streaming') &&
    !canTransition('pending', 'streaming') &&
    !canTransition('failed', 'running')
  report(
    '[1/6] 状态机',
    legal && illegal,
    legal && illegal
      ? 'pending→running→streaming→done 放行，done→streaming / pending→streaming 被拒'
      : `合法转换放行=${legal}，非法转换被拒=${illegal}（终态还能往外转，说明转换表没生效）`
  )

  // 2. 一次完整往返：seq 从 0 开始、连续、不跳号，最后收到 done
  const round = await streamRun(base, (await postChat(base, 's-round', '我的订单到哪了')).runId)
  report(
    '[2/6] 完整往返 + 保序',
    round.seqs.length > 0 && isSequential(round.seqs) && round.lastEvent === 'done',
    `收到 ${round.seqs.length} 个片段，seq 前 12 号：${round.seqs.slice(0, 12).join(',')}，收尾事件：${round.lastEvent}`
  )
  console.log(`      拼回来的回复：${round.text || '(空)'}`)

  // 3. 多个等待者：同一个 run 被两处订阅，两边都要拿到完整内容
  const fanout = await postChat(base, 's-fanout', '两个页面同时开着')
  const [a, b] = await Promise.all([streamRun(base, fanout.runId), streamRun(base, fanout.runId)])
  report(
    '[3/6] 多个 SSE 等待者',
    a.seqs.length > 0 && a.seqs.length === b.seqs.length && a.text === b.text,
    `A 收到 ${a.seqs.length} 个片段，B 收到 ${b.seqs.length} 个，内容一致=${a.text === b.text}`
  )

  // 4. 断线重连：读几个片段就断，带 Last-Event-ID 回来续
  const resume = await postChat(base, 's-resume', '中途断网再连回来')
  const before = await streamRun(base, resume.runId, { stopAfter: 5 })
  const after = await streamRun(base, resume.runId, { lastEventId: before.lastId })
  const all = [...before.seqs, ...after.seqs]
  const noDup = new Set(all).size === all.length
  report(
    '[4/6] 断线重连',
    noDup && isSequential(all) && after.seqs[0] === Number(before.lastId) + 1,
    `断开前收到 ${before.seqs.length} 个（最后一号 ${before.lastId}），重连后第一号 ${after.seqs[0] ?? '(无)'}，合起来无重复=${noDup}、无缺号=${isSequential(all)}`
  )

  // 5. 30 秒内的第二条消息：合并进同一个 run，而不是并发两个
  const one = await postChat(base, 's-merge', '我要退货')
  await sleep(200)
  const two = await postChat(base, 's-merge', '算了改成换货')
  const mergedRun = await streamRun(base, one.runId)
  const sameRun = two.runId === one.runId && (await store.latestRun('s-merge'))?.id === one.runId
  report(
    '[5/6] 30 秒内打断合并',
    two.merged && sameRun && mergedRun.text.includes('换货') && isSequential(mergedRun.seqs),
    `第二条 merged=${two.merged}，仍是同一个 run=${sameRun}，输出提到「换货」=${mergedRun.text.includes('换货')}，seq 仍连续=${isSequential(mergedRun.seqs)}`
  )

  // 6. 超过 30 秒：正常新建（把 created_at 往前挪 31 秒来模拟）
  const old = await postChat(base, 's-stale', '三十一秒前问的问题')
  await sleep(150)
  await store.shiftCreatedAt(old.runId, -31_000)
  const fresh = await postChat(base, 's-stale', '这是一个新问题')
  report(
    '[6/6] 超窗新建',
    !fresh.merged && fresh.runId !== old.runId,
    `merged=${fresh.merged}，新 runId 与旧的不同=${fresh.runId !== old.runId}`
  )

  const passed = results.filter(Boolean).length
  console.log(`=== 自检结束：${passed}/${results.length} 项通过 ===`)
  return passed === results.length
}

async function main(): Promise<void> {
  const bus = createBus()
  const store = createStore()
  await store.init()
  await bus.ensureGroup(RUNS_STREAM, GROUP)

  const role = process.env.ROLE ?? 'all'
  const workerId = process.env.WORKER_ID ?? 'worker-1'
  const worker = role === 'gateway' ? undefined : startWorker(bus, store, workerId)
  if (role === 'worker') {
    console.log(`worker ${workerId} 已启动，等待 ${RUNS_STREAM} 上的 run`)
    return
  }

  const app = createGateway(bus, store)
  await app.listen({ port: PORT, host: HOST })
  const base = `http://127.0.0.1:${PORT}`
  console.log(`gateway 已启动：${base}（MOCK=${process.env.MOCK ?? '0'}）`)

  if (process.env.SELFTEST === '1') {
    console.log('=== 自检开始 ===')
    const ok = await selfTest(base, store)
    await worker?.stop()
    await app.close()
    await store.close()
    await bus.close()
    process.exit(ok ? 0 : 1)
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`收到 ${signal}，停止接受新连接……`)
      void app.close().then(() => process.exit(0))
    })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
