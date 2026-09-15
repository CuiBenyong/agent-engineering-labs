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
import { buildScript, parseInject, type ScriptStep } from '../src/server/scenarios'
import { createFrameBuffer } from '../src/stream/frame-buffer'
import {
  appendArgs,
  applyResult,
  createToolCall,
  describeArgs,
  finalizeArgs,
  looksDestructive,
} from '../src/stream/tool-calls'
import {
  buildInterruptScript,
  buildResumeScript,
  buildToolScript,
  readInterrupt,
} from '../src/server/script-tools'
import { parseIncrementalMarkdown, parseInline } from '../src/stream/incremental-markdown'
import { applyPatch } from '../src/stream/json-patch'
import { createAnnouncer } from '../src/stream/announcer'
import { checkBudget, DEFAULT_BUDGET } from '../src/stream/budget'
import { ResumeTracker, dedupeKey } from '../src/stream/resume'
import {
  activePath,
  appendTurn,
  branchInfo,
  createTree,
  editAndResend,
  switchBranch,
} from '../src/stream/session-tree'
import {
  buildResumeScript as buildReplayScript,
  buildWorkbenchScript,
} from '../src/server/script-workbench'
import {
  MAX_DEPTH,
  resolveComponent,
  sanitizeNode,
  tryParsePartial,
  type UiNode,
} from '../src/stream/generative'
import { buildGenerativeScript, buildUnknownComponentScript } from '../src/server/script-generative'
import { buildBadPatchScript, buildReasoningScript } from '../src/server/script-reasoning'

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
  console.log('D7 自检：协议层、渲染、审批、状态、生成式、会话树、续播、无障碍播报与性能预算')
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

    // --- 工具调用归并 ---
    console.log('\n[8] 工具调用归并')
    const toolSteps = buildToolScript({ threadId: 't', runId: 'r', inject: 'none' })
    const argEvents = toolSteps.filter((s) => s.event.type === 'TOOL_CALL_ARGS')
    check(
      '参数是分多片到达的（否则后面的断言没意义）',
      argEvents.length > 1,
      `实际 ${argEvents.length} 片`
    )

    let call = createToolCall('c1', 'search_documents')
    check('初始状态是 preparing', call.status === 'preparing')

    // 逐片喂参数。中途界面绝不能把半截 JSON 原文显示给用户——
    // 那看起来像出错了。写 D3 时先写的断言是「args 仍为 null」，
    // 变异检验发现它恒真（提前 parse 半截 JSON 本来就失败返回 null），
    // 所以改成盯真正有用户可见后果的这一条。
    let sawPartial = false
    for (const step of argEvents) {
      call = appendArgs(call, (step.event as { delta: string }).delta)
      // 只在第一次进入「参数未收齐」时断言一次，但循环要把参数喂完，
      // 否则后面「参数收齐后 parse 成功」那条会因为参数缺一半而误红。
      if (!sawPartial && call.status === 'preparing' && call.rawArgs.length > 4) {
        sawPartial = true
        const shown = describeArgs(call)
        check(
          '参数没收齐时不把半截 JSON 显示给用户',
          !shown.includes(call.rawArgs) && shown.includes('正在准备'),
          `显示的是 ${JSON.stringify(shown)}`
        )
      }
    }
    check('确实走到了参数未收齐的状态（防止上一条空转）', sawPartial)

    call = finalizeArgs(call)
    check('参数收齐后 parse 成功', call.args !== null, JSON.stringify(call.rawArgs))
    check('parse 出正确的字段', call.args?.limit === 5, JSON.stringify(call.args))
    check('状态转为 running', call.status === 'running')

    call = applyResult(call, JSON.stringify({ hits: 3 }))
    check('拿到结果后状态为 success', call.status === 'success')

    // 坏 JSON 不能让界面崩
    let bad = createToolCall('c2', 'broken_tool')
    bad = appendArgs(bad, '{"path": "abc')
    bad = finalizeArgs(bad)
    check('参数不是合法 JSON 时标记为 error 而不是抛异常', bad.status === 'error')
    check('错误信息里保留了原文，便于排查', (bad.result ?? '').includes('abc'))

    // 拒绝是独立状态，不等同于失败
    let rejected = createToolCall('c3', 'delete_files')
    rejected = applyResult(rejected, JSON.stringify({ error: 'rejected_by_user' }))
    check('用户拒绝是 rejected 而不是 error', rejected.status === 'rejected')

    check('危险工具能被识别出来', looksDestructive('delete_files') === true)
    check('只读工具不会被误判为危险', looksDestructive('search_documents') === false)

    // --- 中断与恢复 ---
    console.log('\n[9] 中断与恢复')
    const interruptSteps = buildInterruptScript({ threadId: 't', runId: 'r', inject: 'interrupt' })
    const last = interruptSteps[interruptSteps.length - 1].event
    check(
      '中断剧本以 RUN_FINISHED 结束（运行真的结束了，不是流挂着）',
      last.type === 'RUN_FINISHED'
    )

    const interrupt = readInterrupt(last as never)
    check('RUN_FINISHED 带 interrupt outcome', interrupt !== null)
    check('中断带 interruptId', (interrupt?.interruptId ?? '').length > 0)
    check('中断带可读的原因', (interrupt?.reason ?? '').length > 0)

    check(
      '中断剧本里没有 TOOL_CALL_RESULT（工具还没执行）',
      !interruptSteps.some((s) => s.event.type === 'TOOL_CALL_RESULT')
    )

    const approved = buildResumeScript(
      { threadId: 't', runId: 'r2', inject: 'none' },
      { interruptId: 'i1', status: 'resolved', payload: { toolCallId: 'c1' } }
    )
    const approvedResult = approved.find((s) => s.event.type === 'TOOL_CALL_RESULT')
    check('同意后续跑会真的产生工具结果', approvedResult !== undefined)
    check(
      '同意后的结果不是拒绝',
      !((approvedResult?.event as { content?: string })?.content ?? '').includes('rejected')
    )

    const cancelled = buildResumeScript(
      { threadId: 't', runId: 'r3', inject: 'none' },
      { interruptId: 'i1', status: 'cancelled', payload: { toolCallId: 'c1' } }
    )
    const cancelledResult = cancelled.find((s) => s.event.type === 'TOOL_CALL_RESULT')
    check('拒绝后也要给模型一个结果，而不是让运行失败', cancelledResult !== undefined)
    check(
      '拒绝的结果里说明了原因',
      ((cancelledResult?.event as { content?: string })?.content ?? '').includes('rejected_by_user')
    )
    check(
      '拒绝后整个运行仍然是成功结束的（不是 RUN_ERROR）',
      !cancelled.some((s) => s.event.type === 'RUN_ERROR')
    )

    // --- JSON Patch ---
    console.log('\n[10] JSON Patch')
    const doc = { a: 1, nested: { list: [1, 2, 3] }, obj: { keep: true } }

    const added = applyPatch(doc, [{ op: 'add', path: '/b', value: 2 }])
    check('add 能加新键', added.ok && (added.state as { b?: number }).b === 2)
    check('add 不修改原对象（原状态没有被就地改动）', !('b' in doc))

    const replaced = applyPatch(doc, [{ op: 'replace', path: '/a', value: 9 }])
    check('replace 能改已有键', replaced.ok && (replaced.state as { a: number }).a === 9)

    const removed = applyPatch(doc, [{ op: 'remove', path: '/a' }])
    check('remove 能删键', removed.ok && !('a' in (removed.state as object)))

    const appended = applyPatch(doc, [{ op: 'add', path: '/nested/list/-', value: 4 }])
    check(
      '数组末尾追加用 - 号',
      appended.ok && (appended.state as typeof doc).nested.list.length === 4
    )

    const inserted = applyPatch(doc, [{ op: 'add', path: '/nested/list/0', value: 0 }])
    check('数组按下标插入', inserted.ok && (inserted.state as typeof doc).nested.list[0] === 0)

    // replace 到不存在的键必须失败：宽容处理会把两端不一致藏起来
    const badReplace = applyPatch(doc, [{ op: 'replace', path: '/nope', value: 1 }])
    check('replace 不存在的路径要失败，而不是当 add 处理', !badReplace.ok)
    check('失败时返回的是原状态', badReplace.state === doc)

    const badPath = applyPatch(doc, [{ op: 'replace', path: '/obj/missing/deep', value: 1 }])
    check('路径中间断掉时失败', !badPath.ok)

    // 全有或全无：第二条失败时第一条也不能留下痕迹
    const partial = applyPatch(doc, [
      { op: 'add', path: '/ok', value: 1 },
      { op: 'replace', path: '/definitely/missing', value: 2 },
    ])
    check('一组补丁里有一条失败就整组不生效', !partial.ok)
    check(
      '失败后不留半应用的状态',
      !('ok' in (partial.state as object)),
      JSON.stringify(partial.state)
    )

    // JSON Pointer 转义：~1 是 /，~0 是 ~
    const escaped = applyPatch({ 'a/b': 1 }, [{ op: 'replace', path: '/a~1b', value: 2 }])
    check('JSON Pointer 的 ~1 正确解成斜杠', escaped.ok)

    check('打不上时不抛异常而是返回失败结果', typeof badReplace.ok === 'boolean')

    // --- 推理与状态剧本 ---
    console.log('\n[11] 推理与共享状态剧本')
    const rs = buildReasoningScript({ threadId: 't', runId: 'r', inject: 'none' })

    check(
      '推理用 REASONING_* 而不是已弃用的 THINKING_*',
      rs.some((s) => s.event.type === 'REASONING_START') &&
        !rs.some((s) => s.event.type.startsWith('THINKING'))
    )
    check(
      '推理内容是流式的（多条增量）',
      rs.filter((s) => s.event.type === 'REASONING_MESSAGE_CONTENT').length > 1
    )
    check(
      '推理事件与文本消息事件用的是不同类型（不会混进同一条消息）',
      rs.some((s) => s.event.type === 'TEXT_MESSAGE_START') &&
        rs.some((s) => s.event.type === 'REASONING_START')
    )

    const snapshots = rs.filter((s) => s.event.type === 'STATE_SNAPSHOT')
    const statePatches = rs.filter((s) => s.event.type === 'STATE_DELTA')
    check('先有快照打底', snapshots.length >= 1)
    check('之后是增量补丁', statePatches.length > 1, `实际 ${statePatches.length} 条`)
    check('快照在第一条补丁之前', rs.indexOf(snapshots[0]) < rs.indexOf(statePatches[0]))

    // 把剧本里的补丁依次打到快照上，验证它们真能打上
    let live: unknown = (snapshots[0].event as unknown as { snapshot: unknown }).snapshot
    let appliedAll = true
    for (const step of statePatches) {
      const r = applyPatch(live, (step.event as unknown as { delta: never[] }).delta)
      if (!r.ok) appliedAll = false
      live = r.state
    }
    check('剧本里的补丁全部能打到快照上', appliedAll)
    check(
      '打完之后状态里出现了新指标',
      JSON.stringify(live).includes('qoq'),
      JSON.stringify(live).slice(0, 60)
    )

    // 坏补丁剧本
    const badScript = buildBadPatchScript({ threadId: 't', runId: 'r', inject: 'slow' })
    const badSnapshot = badScript.find((s) => s.event.type === 'STATE_SNAPSHOT')
    const badDelta = badScript.find((s) => s.event.type === 'STATE_DELTA')
    const badResult = applyPatch(
      (badSnapshot!.event as unknown as { snapshot: unknown }).snapshot,
      (badDelta!.event as unknown as { delta: never[] }).delta
    )
    check('坏补丁剧本里的补丁确实打不上（否则这个剧本没意义）', !badResult.ok)
    check(
      '坏补丁之后剧本补发了一份完整快照供重新对齐',
      badScript.filter((s) => s.event.type === 'STATE_SNAPSHOT').length >= 2
    )

    {
      // --- 生成式界面：静态范式 ---
      console.log('\n[12] 生成式界面（静态范式）')

      const okSpec = resolveComponent({
        component: 'metric',
        props: { label: '营收', value: 100, unit: '元' },
      })
      check('注册表里的组件能解析', okSpec.ok)

      const unknownComp = resolveComponent({ component: 'timeline_3d', props: {} })
      check('未注册组件被拒绝', !unknownComp.ok)
      check(
        '未注册与数据不合法是两种不同的失败（排查方向不同）',
        !unknownComp.ok && unknownComp.reason === 'unknown-component'
      )

      const badProps = resolveComponent({
        component: 'metric',
        props: { label: '营收', value: '一百二十八万' },
      })
      check('组件名对但数据类型错也要被拒绝', !badProps.ok)
      check(
        '数据不合法报的是 invalid-props 而不是 unknown-component',
        !badProps.ok && badProps.reason === 'invalid-props'
      )

      const missing = resolveComponent({ component: 'metric', props: { label: '营收' } })
      check('缺必填字段被拒绝', !missing.ok)

      // 流式中途的半截 JSON
      check('半截 JSON 解析出 null 而不是抛异常', tryParsePartial('{"component":"met') === null)
      check(
        '完整 JSON 能解析',
        tryParsePartial('{"component":"metric","props":{}}')?.component === 'metric'
      )

      // --- 生成式界面：声明式范式 ---
      console.log('\n[13] 生成式界面（声明式范式）')

      const mixedTree: UiNode = {
        type: 'stack',
        children: [
          { type: 'heading', text: '标题' },
          { type: 'script', text: 'alert(1)' },
          { type: 'text', text: '正常内容' },
        ],
      }
      const safe = sanitizeNode(mixedTree)
      check('合法节点保留原类型', safe.type === 'stack')
      check('子节点数量不变（降级而不是删除）', safe.children.length === 3)
      check(
        '非法节点被降级成纯文本而不是让整棵树失败',
        safe.children[1].type === 'text' && safe.children[1].issue === 'unknown-type'
      )
      check(
        '非法节点旁边的正常内容照常渲染',
        safe.children[2].type === 'text' && safe.children[2].text === '正常内容'
      )
      check(
        '降级后的节点不保留原始类型名以外的任何可执行内容',
        !('children' in mixedTree.children![1])
      )

      // 深度上限：递归生成跑偏会产出深到爆栈的树
      let deep: UiNode = { type: 'text', text: '底' }
      for (let i = 0; i < MAX_DEPTH + 4; i += 1) deep = { type: 'stack', children: [deep] }
      const sanitizedDeep = sanitizeNode(deep)
      let depth = 0
      let cursor = sanitizedDeep
      while (cursor.children.length > 0) {
        cursor = cursor.children[0]
        depth += 1
      }
      check('超深的树被截断而不是爆栈', depth <= MAX_DEPTH, `实际深度 ${depth}`)
      check('被截断处留下了可见的说明', cursor.issue === 'too-deep' || cursor.text !== undefined)

      // --- 剧本 ---
      console.log('\n[14] 生成式剧本')
      const gen = buildGenerativeScript({ threadId: 't', runId: 'r', inject: 'none' })
      const customs = gen.filter((s) => s.event.type === 'CUSTOM')
      check('生成式内容走 CUSTOM 事件', customs.length >= 3, `实际 ${customs.length} 条`)

      const allResolve = customs
        .filter((step: ScriptStep) => (step.event as { name: string }).name === 'ui.component')
        .every(
          (step: ScriptStep) =>
            resolveComponent((step.event as unknown as { value: never }).value).ok
        )
      check('正常剧本里的组件全部能解析（否则示例本身就是坏的）', allResolve)

      const fallbackScript = buildUnknownComponentScript({
        threadId: 't',
        runId: 'r',
        inject: 'unknown-component',
      })
      const badCustoms = fallbackScript.filter((s) => s.event.type === 'CUSTOM')
      const badComponents = badCustoms.filter(
        (step: ScriptStep) => (step.event as { name: string }).name === 'ui.component'
      )
      const failures = badComponents.filter(
        (step: ScriptStep) =>
          !resolveComponent((step.event as unknown as { value: never }).value).ok
      )
      check('兜底剧本里确实有解析失败的组件（防止这组断言空转）', failures.length >= 2)
      check(
        '兜底剧本以一个正常组件收尾，证明失败不影响后续渲染',
        resolveComponent(
          (badComponents[badComponents.length - 1].event as unknown as { value: never }).value
        ).ok
      )
    }

    {
      // --- 会话树 ---
      console.log('\n[15] 会话树')
      let t = createTree()
      t = appendTurn(t, '第一问')
      t = appendTurn(t, '第二问')
      check('线性追加后路径上有两轮', activePath(t).filter((n) => n.userText).length === 2)

      const secondId = activePath(t)[2].id
      t = editAndResend(t, secondId, '第二问的另一种问法')
      const path = activePath(t).filter((n) => n.userText)
      check('编辑重发后路径仍是两轮（替换而不是追加）', path.length === 2, `实际 ${path.length}`)
      check('当前分支用的是新文本', path[1].userText === '第二问的另一种问法')

      const info = branchInfo(t, path[1].id)
      check(
        '旧分支没有被删除（这是树相对线性历史的全部价值）',
        info.total === 2,
        `实际 ${info.total}`
      )
      check('当前停在新分支上', info.index === 1)

      t = switchBranch(t, info.siblings[0])
      check(
        '能切回旧分支并看到原来的文本',
        activePath(t).filter((n) => n.userText)[1].userText === '第二问'
      )

      // --- 续播去重 ---
      console.log('\n[16] 续播去重')
      const full = buildWorkbenchScript({ threadId: 't', runId: 'r', inject: 'none' })
      check(
        '剧本给每个事件编了序号（续播的前提）',
        full.every((step) => typeof step.event.metadata?.seq === 'number')
      )

      const tracker = new ResumeTracker()
      // 先收前 12 条
      const firstHalf = full.slice(0, 12)
      for (const step of firstHalf) tracker.accept(step.event)
      const lastSeq = tracker.resumeFrom
      check('追踪器记住了最后收到的序号', lastSeq === 11, `实际 ${lastSeq}`)

      // 续播：服务端故意多回放几条
      const replay = buildReplayScript({ threadId: 't', runId: 'r', inject: 'none' }, lastSeq)
      const replayedSeqs = replay.map((step) => step.event.metadata?.seq as number)
      const overlap = replayedSeqs.filter((n) => n <= lastSeq)
      check(
        '续播确实重复发了已收到的事件（否则这组断言空转）',
        overlap.length > 0,
        `重复 ${overlap.length} 条`
      )

      const accepted = replay.filter((step) => tracker.accept(step.event))
      check(
        '重复的事件全部被去掉',
        accepted.every((step) => (step.event.metadata?.seq as number) > lastSeq)
      )
      check('新事件没有被误杀', accepted.length === replay.length - overlap.length)

      // --- 按内容去重是错的 ---
      console.log('\n[17] 去重口径')
      check(
        '增量类事件不参与按标识去重（同一条消息的多个增量共用 messageId）',
        dedupeKey({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' } as never) === null
      )
      check(
        '开始与结束这类幂等事件参与按标识去重',
        dedupeKey({ type: 'TEXT_MESSAGE_START', messageId: 'm1' } as never) !== null
      )

      // 模型完全可能连续吐出两个一模一样的增量（两个空格、重复的标点）。
      // 按内容去重会把合法的重复吃掉，表现是正文莫名少字且极难复现。
      const t2 = new ResumeTracker()
      const dup1 = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '  ' } as never
      const dup2 = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '  ' } as never
      check('内容相同的两个增量都要被接受，不能当成重复吃掉', t2.accept(dup1) && t2.accept(dup2))

      // --- 子 Agent 归组 ---
      console.log('\n[18] 子 Agent')
      const subStarts = full.filter((step) => step.event.type === 'SUBAGENT_STARTED')
      check('剧本里有两个子 Agent', subStarts.length === 2)

      const subTexts = full.filter(
        (step) =>
          step.event.type === 'TEXT_MESSAGE_CONTENT' &&
          typeof (step.event as { subagentRunId?: string }).subagentRunId === 'string'
      )
      check('子 Agent 的消息带 subagentRunId', subTexts.length > 0)

      const ids = new Set(
        subTexts.map((step) => (step.event as { subagentRunId: string }).subagentRunId)
      )
      check('两个子 Agent 的消息都存在', ids.size === 2, `实际 ${ids.size} 个`)

      // 交错到达：按顺序拼一定串台，必须按标识归组
      const order = subTexts.map((step) => (step.event as { subagentRunId: string }).subagentRunId)
      let interleaved = false
      for (let i = 1; i < order.length; i += 1) if (order[i] !== order[i - 1]) interleaved = true
      check('两个子 Agent 的事件确实是交错到达的（否则归组断言没意义）', interleaved)

      // --- 长任务步骤 ---
      console.log('\n[19] 长任务步骤')
      const stepStarts = full.filter((step: ScriptStep) => step.event.type === 'STEP_STARTED')
      const stepEnds = full.filter((step: ScriptStep) => step.event.type === 'STEP_FINISHED')
      check('有多个运行阶段', stepStarts.length >= 3, `实际 ${stepStarts.length}`)
      check('每个开始都有对应的结束', stepStarts.length === stepEnds.length)
    }

    {
      // --- 无障碍播报 ---
      console.log('\n[20] 分段播报')
      const spoken: string[] = []
      const ann = createAnnouncer({ emit: (t) => spoken.push(t) })

      // 模拟流式：每次喂入到目前为止的完整文本
      const full = '同声传译的难处不在词汇量。它在于必须在信息不完整时开口！流式界面也是一样。'
      for (let i = 1; i <= full.length; i += 1) ann.update(full.slice(0, i))
      ann.finish()

      check('按句子分段播报，而不是逐字播报', spoken.length === 3, `实际 ${spoken.length} 段`)
      check(
        '每一段都是完整的句子',
        spoken.every((t) => /[。！？；.!?;]$/.test(t)),
        JSON.stringify(spoken)
      )
      check('第一段内容正确', spoken[0] === '同声传译的难处不在词汇量。', JSON.stringify(spoken[0]))
      check(
        '播报的内容拼起来等于原文（没漏也没重）',
        spoken.join('') === full,
        JSON.stringify(spoken.join(''))
      )

      // 逐字播报是错的：如果实现退化成每次都播报全文，段数会等于字符数
      check('播报段数远少于字符数（没有退化成逐字播报）', spoken.length < full.length / 10)

      // 没有句末标点的长文本要靠兜底切段，否则永远不播报
      const noPunct: string[] = []
      const ann2 = createAnnouncer({ emit: (t) => noPunct.push(t), maxChars: 20 })
      const longText = '这是一段很长的没有任何标点的文字'.repeat(4)
      for (let i = 1; i <= longText.length; i += 1) ann2.update(longText.slice(0, i))
      check('没有标点的长文本也会被兜底切段播报', noPunct.length > 0, `实际 ${noPunct.length} 段`)

      // 收尾：最后一句没有标点也要播报掉
      const tail: string[] = []
      const ann3 = createAnnouncer({ emit: (t) => tail.push(t) })
      ann3.update('第一句话。第二句没写完')
      const beforeFinish = tail.length
      ann3.finish()
      check('收尾前最后一句未播报（因为还没结束）', beforeFinish === 1, `实际 ${beforeFinish}`)
      check('收尾时把没有标点的最后一句也播报掉', tail.length === 2, `实际 ${tail.length}`)
      check('最后一句内容正确', tail[1] === '第二句没写完', JSON.stringify(tail[1]))

      // 跨消息复用播报器的回归断言。
      //
      // 这个 bug 是浏览器实测抓到的，逻辑层原本没覆盖：播报器按「一条消息」
      // 追踪已播报的偏移量，第二条消息开始时如果不重置，开头一截会被当成
      // 「已经念过」而跳过。实测时第二句被切成了「速高于行业均值。」
      const msg1: string[] = []
      const ann4 = createAnnouncer({ emit: (t) => msg1.push(t) })
      ann4.update('第一条消息。')
      ann4.finish()
      ann4.reset() // 新消息开始
      ann4.update('第二条消息的完整内容。')
      ann4.finish()
      check(
        '重置后新消息从头播报，不会被上一条的偏移量切掉开头',
        msg1[1] === '第二条消息的完整内容。',
        JSON.stringify(msg1)
      )

      // --- 性能预算 ---
      console.log('\n[21] 性能预算')
      const good = checkBudget({
        timeToFirstTokenMs: 400,
        longestTaskMs: 20,
        updatesPerSecond: 55,
        domNodes: 800,
      })
      check(
        '全部达标时每条都是 ok',
        good.every((c) => c.ok)
      )

      const bad = checkBudget({
        timeToFirstTokenMs: 3000,
        longestTaskMs: 200,
        updatesPerSecond: 300,
        domNodes: 40000,
      })
      check(
        '全部超标时每条都不 ok',
        bad.every((c) => !c.ok)
      )
      check('超标项报告了实际值与上限', bad[0].actual === 3000 && bad[0].limit > 0)

      // 没测到的指标要如实表达「没数据」，不能算超标也不能算通过
      const partial = checkBudget({
        timeToFirstTokenMs: null,
        longestTaskMs: 10,
        updatesPerSecond: 10,
        domNodes: 100,
      })
      check('没测到的指标 actual 为 null 而不是 0', partial[0].actual === null)
      check('首字延迟这条存在于预算里', DEFAULT_BUDGET.timeToFirstTokenMs > 0)
    }
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
