/**
 * 自检：不启动 Next，直接验协议层。
 *
 * 做法：起一个 node:http 最小服务端，用本课的 encodeEvent 吐真实 SSE，
 * 再用本课的 decodeEventStream 读回来逐条断言。
 * 这样验的是「编码 → 网络 → 解码」这条真实链路，而不是把函数在内存里调一遍。
 *
 * 跑：pnpm selftest
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decodeEventStream, encodeEvent } from '../src/protocol/decode'
import {
  isKnownEvent,
  type BaseEvent,
  type RunErrorEvent,
  type TextMessageContentEvent,
} from '../src/protocol/events'
import { buildScript, parseInject } from '../src/server/scenarios'
import { createFrameBuffer } from '../src/stream/frame-buffer'
import { parseIncrementalMarkdown, parseInline } from '../src/stream/incremental-markdown'

let failures = 0

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 起一个按剧本吐 SSE 的最小服务端，返回基地址与关闭函数。 */
async function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const inject = parseInject(url.searchParams.get('inject'))
    const steps = buildScript({ threadId: 'thread-test', runId: 'run-test', inject })

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    })

    // 故意不按剧本的 delay 等待：自检要快。时序效果留给浏览器里肉眼验。
    for (const step of steps) {
      res.write(encodeEvent(step.event))
    }
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function collect(url: string): Promise<BaseEvent[]> {
  const res = await fetch(url, { method: 'POST' })
  const events: BaseEvent[] = []
  for await (const event of decodeEventStream(res)) {
    events.push(event)
  }
  return events
}

async function main() {
  console.log('D2 自检：协议层、按帧合并、增量 Markdown')
  const { base, close } = await startServer()

  try {
    // --- 正常剧本 ---
    console.log('\n[1] 正常剧本')
    const events = await collect(`${base}/?inject=none`)

    check('收到了事件', events.length > 0, `实际 ${events.length} 条`)
    check('以 RUN_STARTED 开场', events[0]?.type === 'RUN_STARTED', `实际 ${events[0]?.type}`)
    check(
      '包含 RUN_FINISHED',
      events.some((e) => e.type === 'RUN_FINISHED')
    )

    const deltas = events.filter(
      (e): e is TextMessageContentEvent => e.type === 'TEXT_MESSAGE_CONTENT'
    )
    check('有多个文本增量', deltas.length > 1, `实际 ${deltas.length} 个`)

    // 把增量拼回完整文本，验证解码没有在多字节字符边界上丢字。
    const text = deltas.map((e) => e.delta).join('')
    check(
      '增量能拼回完整中文而不乱码',
      text.includes('同声传译') && text.includes('显示出来'),
      text.slice(0, 24)
    )

    // --- 多字节字符的块边界 ---
    //
    // 上面那条「拼回完整中文」其实验不到解码器：真实 HTTP 每次 write 都是一个完整数据块，
    // 中文不会被切断，所以就算把 TextDecoderStream 换成逐块 TextDecoder 它也照样绿
    // （写 D1 时实测过）。要真验，必须自己构造一个从字节中间切开的流。
    console.log('\n[1b] 多字节字符跨块')
    const payload = encodeEvent({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm1',
      delta: '同声传译',
    } as BaseEvent)
    const bytes = new TextEncoder().encode(payload)

    // 找到第一个多字节字符的首字节（UTF-8 里高位是 1 的那种），再往后挪一格，
    // 这一刀就正好落在一个汉字的三个字节中间。
    // 不要写死偏移量：JSON 里字段顺序一变，写死的位置就会切在 ASCII 上，
    // 这条断言会静默变成恒真（写 D1 时就是这么踩的）。
    const firstMultiByte = bytes.findIndex((b) => b >= 0x80)
    const cutAt = firstMultiByte + 1
    const splitStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cutAt))
        controller.enqueue(bytes.slice(cutAt))
        controller.close()
      },
    })

    const split: BaseEvent[] = []
    for await (const event of decodeEventStream(new Response(splitStream))) {
      split.push(event)
    }
    const splitDelta = (split[0] as TextMessageContentEvent | undefined)?.delta
    check(
      '切在汉字字节中间仍能解出完整文字',
      splitDelta === '同声传译',
      `实际 ${JSON.stringify(splitDelta)}`
    )

    // --- 前向兼容 ---
    console.log('\n[2] 前向兼容')
    const unknown = events.filter((e) => !isKnownEvent(e))
    check('剧本里确实有未知事件（防止这条断言空转）', unknown.length > 0)
    check(
      '未知事件被解码出来而不是让整条流抛错',
      unknown.every((e) => typeof e.type === 'string')
    )

    // --- 错误注入 ---
    console.log('\n[3] error 注入')
    const errored = await collect(`${base}/?inject=error`)
    const runError = errored.find((e): e is RunErrorEvent => e.type === 'RUN_ERROR')
    check('收到 RUN_ERROR', Boolean(runError))
    check('RUN_ERROR 带可读的 message', (runError?.message.length ?? 0) > 0)

    // --- 断流注入 ---
    console.log('\n[4] cut 注入')
    const cut = await collect(`${base}/?inject=cut`)
    check('断流剧本比完整剧本短', cut.length < events.length, `${cut.length} < ${events.length}`)
    check(
      '断流时收不到 RUN_FINISHED（界面必须自己回到可操作状态）',
      !cut.some((e) => e.type === 'RUN_FINISHED')
    )

    // --- 风暴注入 ---
    console.log('\n[5] burst 注入')
    const burst = await collect(`${base}/?inject=burst`)
    const burstDeltas = burst.filter(
      (e): e is TextMessageContentEvent => e.type === 'TEXT_MESSAGE_CONTENT'
    )
    check(
      '风暴模式的增量数远多于正常模式',
      burstDeltas.length > deltas.length * 5,
      `${burstDeltas.length} vs ${deltas.length}`
    )

    // --- 按帧合并 ---
    console.log('\n[6] 按帧合并')
    await new Promise<void>((resolve) => {
      const flushed: string[][] = []
      const buffer = createFrameBuffer<string>({
        flush: (batch) => flushed.push(batch),
        fallbackDelayMs: 0,
      })

      // 一帧之内推 100 个增量
      for (let i = 0; i < 100; i += 1) buffer.push(`d${i}`)

      setTimeout(() => {
        check('100 个增量只触发 1 次状态更新', flushed.length === 1, `实际 ${flushed.length} 次`)
        check('合并后一个增量都没丢', flushed[0]?.length === 100, `实际 ${flushed[0]?.length}`)
        check('顺序保持不变', flushed[0]?.[0] === 'd0' && flushed[0]?.[99] === 'd99')

        // 跨帧的增量必须分批，不能被攒成一批
        buffer.push('next-frame')
        setTimeout(() => {
          check('下一帧的增量单独 flush', flushed.length === 2, `实际 ${flushed.length} 次`)
          buffer.dispose()
          resolve()
        }, 5)
      }, 5)
    })

    // --- 增量 Markdown ---
    console.log('\n[7] 增量 Markdown')

    // 围栏开了没关：必须仍然当代码块渲染，并标记未完成
    const openFence = parseIncrementalMarkdown('说明：\n```ts\nconst a = 1')
    const codeBlock = openFence.find((b) => b.kind === 'code')
    check('未闭合的围栏仍被识别为代码块', codeBlock?.kind === 'code')
    check(
      '未闭合的代码块标记为 complete=false',
      codeBlock?.kind === 'code' && codeBlock.complete === false
    )
    check(
      '未闭合代码块的内容正确',
      codeBlock?.kind === 'code' && codeBlock.text === 'const a = 1',
      codeBlock?.kind === 'code' ? JSON.stringify(codeBlock.text) : ''
    )

    const closedFence = parseIncrementalMarkdown('```ts\nconst a = 1\n```')
    const closed = closedFence.find((b) => b.kind === 'code')
    check('闭合的围栏标记为 complete=true', closed?.kind === 'code' && closed.complete === true)

    // 行内标记只开了口：当普通文本，不要提前加粗
    const halfBold = parseInline('这是 **还没写完')
    check(
      '未闭合的粗体当普通文本处理，不提前加粗',
      halfBold.every((t) => t.kind === 'text'),
      JSON.stringify(halfBold.map((t) => t.kind))
    )

    const fullBold = parseInline('这是 **写完了** 的')
    check(
      '闭合的粗体正确识别',
      fullBold.some((t) => t.kind === 'strong' && t.text === '写完了')
    )
  } finally {
    await close()
  }

  console.log('')
  if (failures > 0) {
    console.error(`自检失败：${failures} 项不通过`)
    process.exit(1)
  }
  console.log('自检通过')
}

main().catch((error) => {
  console.error('自检崩溃', error)
  process.exit(1)
})
