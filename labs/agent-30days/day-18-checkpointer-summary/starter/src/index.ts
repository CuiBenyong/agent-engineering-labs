import 'dotenv/config'
import type { Checkpoint } from '@langchain/langgraph'
import { buildGraph, forkFrom, resumeRun, threadConfig, type GraphState } from './graph'
import { createSaver, PgSaver } from './infra/checkpoints'
import { modelCallCount, resetModelCallCount } from './infra/model'
import { attachmentRefs, migrateAttachments, migrateWorkspace } from './shared/compat'
import { KEEP_RECENT, MAX_MESSAGES, MAX_TOKENS, estimateTokens } from './shared/summarize'
import type { Attachment, Message } from './shared/state'

const results: boolean[] = []

// 五项自检的标题与失败提示，提示逐条对应 starter 里的练习点
const ITEMS: [string, string][] = [
  [
    '摘要触发、历史保真、附件不被动',
    'needsSummary / buildSummaryUpdate 还没实现：历史再长也压不短（练习 1）',
  ],
  [
    '中断后从检查点恢复，状态一字不差',
    'resume 又把整份历史喂了一遍，等于开了一条新线而不是恢复（练习 2）',
  ],
  ['Send 携带的子任务参数进没进检查点', '这一项不依赖练习，它是本章要你亲眼验证的事实'],
  ['从中间某个检查点分叉', 'forkFrom 没带 checkpoint_id，分叉退化成了在最新状态上追加（练习 3）'],
  ['老检查点的版本兼容', 'migrateAttachments / migrateWorkspace 还没实现（练习 4）'],
]

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/5] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

const ATTACHMENT: Attachment = {
  id: 'att-1',
  kind: 'image',
  ref: 'blob://tickets/2026/att-1.png',
  caption: '用户上传的破损外包装照片',
}

/** 造一段长对话。轮数与每条长度可调，用来分别撞两个阈值。 */
function makeHistory(turns: number, padding = 0): Message[] {
  const history: Message[] = []
  for (let i = 1; i <= turns; i += 1) {
    const pad = '·'.repeat(padding)
    history.push({
      role: 'user',
      content: `第 ${i} 轮：订单 SO2026090${(i % 2) + 1} 实付 ${100 + i} 元，包装未拆封${pad}`,
    })
    history.push({
      role: 'assistant',
      content: `第 ${i} 轮回复：该单已出库，未拆封 7 天内可退${pad}`,
    })
  }
  return history
}

const REQUEST = '订单 SO20260901 现在什么状态、物流到哪了、能不能退款'

/**
 * 把任意值序列化成「键序无关」的 JSON。
 *
 * 为什么需要它：Postgres 的 jsonb **不保存键序**——它会把对象的键重排、去掉重复键和空白。
 * 于是同一份状态，从内存版读回来键序是你写进去的样子，从 jsonb 读回来是排过序的样子。
 * 拿 JSON.stringify 直接比字节，在真实存储上会给你一个假的「状态变了」。
 * **检查点的等价性判断必须是语义等价，不是字节等价。**
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        )
      : val
  )
}

// ---------------------------------------------------------------------------

/** 自检用到的几条线。检查点是**持久**的，所以每次自检先把上一轮的清掉，否则第二次跑会接着上一轮往下长。 */
const THREADS = ['sum-count', 'sum-token', 'resume-1', 'fork-1', 'legacy-1']

async function selfTest(): Promise<number> {
  const first = await createSaver()
  console.log(
    `检查点存储：${first.kind}${first.kind === 'postgres' ? `（表 graph_checkpoints）` : '（进程内，重启即失）'}\n`
  )
  for (const thread of THREADS) await first.saver.deleteThread(thread)

  // ---- 1. 摘要：两个阈值各撞一次，最近 6 条原文不动，附件全程不被碰 ----
  const long = [...makeHistory(11), { role: 'user' as const, content: REQUEST }]
  const keptBefore = canonical(long.slice(-KEEP_RECENT))
  const g1 = buildGraph({ checkpointer: first.saver })
  const s1 = await g1.invoke(
    { messages: long, attachments: [ATTACHMENT] },
    { configurable: { thread_id: 'sum-count' } }
  )
  // 条数不超但 token 超：同一个节点、另一条触发路径
  const fat = [...makeHistory(8, 500), { role: 'user' as const, content: REQUEST }]
  const s2 = await g1.invoke({ messages: fat }, { configurable: { thread_id: 'sum-token' } })

  const kept = (s1.messages as Message[]).slice(0, -1)
  const keptAfter = canonical(kept.slice(-KEEP_RECENT))
  console.log(`    摘要：${s1.summary}`)
  console.log(
    `    保留原文 ${kept.length} 条，其中最近 ${KEEP_RECENT} 条与入图前逐字一致：${keptBefore === keptAfter}`
  )
  console.log(`    附件：${JSON.stringify(s1.attachments)}`)
  const ok1 =
    long.length > MAX_MESSAGES &&
    kept.length >= KEEP_RECENT &&
    kept.length < long.length &&
    keptBefore === keptAfter &&
    typeof s1.summary === 'string' &&
    /#\d+\(user\)|#\d+\(assistant\)/.test(s1.summary) &&
    canonical(s1.attachments) === canonical([ATTACHMENT]) &&
    fat.length <= MAX_MESSAGES &&
    estimateTokens(fat) > MAX_TOKENS &&
    typeof s2.summary === 'string'
  check(
    1,
    ok1,
    `${long.length} 条 → 保留 ${kept.length} 条原文（最近 ${KEEP_RECENT} 条逐字一致=${keptBefore === keptAfter}）` +
      ` + ${s1.summary ? '1 段带「第几条+谁说的」的摘要' : '没有生成摘要'}；` +
      `另一条线 ${fat.length} 条 / ${estimateTokens(fat)} token → ${s2.summary ? '也触发了' : '没触发'}；` +
      `附件 ${s1.attachments.length} 件原样`
  )

  // ---- 2. 中断 → 换一个进程 → 恢复，状态一字不差 ----
  const thread = 'resume-1'
  const cfg = { configurable: { thread_id: thread } }
  resetModelCallCount()
  const paused = buildGraph({ checkpointer: first.saver, interruptBefore: ['executor'] })
  await paused.invoke(
    { messages: [{ role: 'user', content: REQUEST }], attachments: [ATTACHMENT] },
    cfg
  )
  const atInterrupt = await paused.getState(cfg)
  const callsBefore = modelCallCount()
  console.log(
    `\n    中断在 executor 之前：next=[${atInterrupt.next.join(', ')}]，已调用模型 ${callsBefore} 次`
  )

  // 「换一个进程」：重新拿一次 saver（Postgres 下是一条全新连接），并重建图对象。
  await first.close()
  const second = await createSaver()
  const revived = buildGraph({ checkpointer: second.saver })
  const afterRestart = await revived.getState(cfg)
  const identical = canonical(atInterrupt.values) === canonical(afterRestart.values)
  // 恢复的入口在 resumeRun 里，它只拿 thread_id 去检查点里接着跑
  const finished = await resumeRun(revived, cfg, { messages: [{ role: 'user', content: REQUEST }] })
  const callsAfter = modelCallCount()
  console.log(
    `    恢复后 workspace：${finished.workspace.map((t) => `${t.id}:${t.status}`).join(' ')}`
  )
  const pausedCount = (atInterrupt.values as GraphState).messages.length
  const ok2 =
    identical &&
    atInterrupt.next.length > 0 &&
    finished.workspace.every((t) => t.status === 'done') &&
    // 恢复只该多出最后那条 assistant 回复；多出一整份历史，说明你把输入又喂了一遍
    finished.messages.length === pausedCount + 1 &&
    callsAfter - callsBefore === finished.workspace.length &&
    canonical(finished.attachments) === canonical([ATTACHMENT])
  check(
    2,
    ok2,
    `重启前后状态完全一致（键序无关比对）=${identical}；恢复后 ${finished.workspace.length} 件全部 done；` +
      `历史从 ${pausedCount} 条变成 ${finished.messages.length} 条（正确的恢复只会多出那条回复，也就是 ${pausedCount + 1} 条）；` +
      `中断前调了 ${callsBefore} 次模型，恢复阶段又调了 ${callsAfter - callsBefore} 次（应当正好等于待执行的 ${finished.workspace.length} 件活）`
  )

  // ---- 3. Send 的参数到底存到哪了 ----
  const tuple = await second.saver.getTuple(cfg)
  const pauseTuple = await second.saver.getTuple({
    configurable: {
      thread_id: thread,
      checkpoint_id: atInterrupt.config.configurable?.checkpoint_id,
    },
  })
  const tasksChannel = pauseTuple?.checkpoint.channel_values['__pregel_tasks'] as
    { node: string; args: { task: { id: string } } }[] | undefined
  console.log(
    `\n    中断点检查点的通道：${Object.keys(pauseTuple?.checkpoint.channel_values ?? {}).join(', ')}`
  )
  console.log(`    __pregel_tasks 里存的 Send：${JSON.stringify(tasksChannel)?.slice(0, 220)}…`)
  if (second.saver instanceof PgSaver) {
    const rows = await second.saver.rawRows(thread)
    console.log(
      `    Postgres 里这条线共 ${rows.length} 行；中断那一行的 state 键：${Object.keys(rows.find((r) => r.checkpoint_id === atInterrupt.config.configurable?.checkpoint_id)?.state ?? {}).join(', ')}`
    )
  }
  const ok3 =
    Array.isArray(tasksChannel) &&
    tasksChannel.length === finished.workspace.length &&
    tasksChannel.every((s) => s.node === 'executor' && typeof s.args?.task?.id === 'string') &&
    tuple !== undefined
  check(
    3,
    ok3,
    `pending 的 ${tasksChannel?.length ?? 0} 个 Send 被完整序列化进了检查点的 __pregel_tasks 通道，` +
      `每个都带着 node 与 args.task；恢复时直接按它派活，planner 不用重跑`
  )

  // ---- 4. 分叉：同一个检查点，换一句输入，走出另一条后续 ----
  const forkThread = 'fork-1'
  const forkCfg = { configurable: { thread_id: forkThread } }
  const g4 = buildGraph({ checkpointer: second.saver })
  const mainLine = (await g4.invoke(
    { messages: [{ role: 'user', content: '订单 SO20260901 现在什么状态' }] },
    forkCfg
  )) as GraphState
  const history: { next: string[]; id: string; messages: number }[] = []
  for await (const snap of g4.getStateHistory(forkCfg)) {
    history.push({
      next: [...snap.next],
      id: snap.config.configurable?.checkpoint_id as string,
      messages: (snap.values as GraphState).messages.length,
    })
  }
  const point = history.find((h) => h.next[0] === 'planner')
  const forked = await forkFrom(g4, forkThread, point?.id ?? '', {
    messages: [{ role: 'user', content: '我要退款，另外物流到哪了' }],
  })
  const replay = await g4.getState(threadConfig(forkThread, point?.id))
  console.log(
    `\n    这条线共 ${history.length} 个检查点：${history
      .map((h) => h.next.join('+') || 'END')
      .reverse()
      .join(' → ')}`
  )
  console.log(
    `    主线子任务 ${mainLine.workspace.map((t) => t.id).join(' ')}｜分叉线 ${forked.workspace.map((t) => t.id).join(' ')}`
  )
  const ok4 =
    point !== undefined &&
    // 分叉线不该带着主线之后才产生的东西：主线拆的是 order，分叉线一件 order 都不该有
    forked.workspace.length === 2 &&
    !forked.workspace.some((t) => t.id.endsWith('-order')) &&
    mainLine.workspace.length !== forked.workspace.length &&
    (replay.values as GraphState).messages.length === point.messages
  check(
    4,
    ok4,
    `从 step 前的同一个检查点出发，主线拆出 ${mainLine.workspace.length} 件、分叉线拆出 ${forked.workspace.length} 件；` +
      `分叉之后原检查点仍然能原样读回（${point?.messages} 条消息，没被覆盖）`
  )

  // ---- 5. 老检查点：状态形状变了之后，恢复会发生什么 ----
  const legacyThread = 'legacy-1'
  const legacy = {
    id: '1f000000-0000-6000-8000-000000000001',
    channel_values: {
      messages: [{ role: 'user', content: '这是发版之前就存在的一条会话' }],
      // v1 的形状：附件的引用字段叫 url，子任务还没有 toolCalls
      attachments: [{ id: 'att-old', kind: 'image', url: 'blob://tickets/2025/att-old.png' }],
      workspace: [{ id: 't-1-order', goal: '查订单状态', status: 'done', result: '已出库' }],
      reviewRounds: 0,
      degraded: false,
    },
  }
  await second.saver.put(
    { configurable: { thread_id: legacyThread, checkpoint_ns: '' } },
    {
      v: 4,
      id: legacy.id,
      ts: new Date().toISOString(),
      channel_values: legacy.channel_values,
      channel_versions: Object.fromEntries(Object.keys(legacy.channel_values).map((k) => [k, 1])),
      versions_seen: {},
    } as unknown as Checkpoint,
    { source: 'update', step: 0, parents: {} },
    {}
  )
  const g5 = buildGraph({ checkpointer: second.saver })
  const old = (await g5.getState({ configurable: { thread_id: legacyThread } }))
    .values as GraphState
  const rawRefs = attachmentRefs(old.attachments)
  const rawBudget = old.workspace[0].toolCalls + 1
  const fixedRefs = attachmentRefs(migrateAttachments(old.attachments))
  const fixedBudget = migrateWorkspace(old.workspace)[0].toolCalls + 1
  console.log(
    `\n    不迁移：附件引用读出来是 ${JSON.stringify(rawRefs)}，预算算出来是 ${rawBudget}（没有一处报错）`
  )
  console.log(`    迁移后：附件引用 ${JSON.stringify(fixedRefs)}，预算 ${fixedBudget}`)
  const ok5 =
    rawRefs[0] === 'undefined' &&
    Number.isNaN(rawBudget) &&
    fixedRefs[0].startsWith('blob://') &&
    fixedBudget === 1
  check(
    5,
    ok5,
    `老检查点缺字段时不抛错、只是静默给出 "undefined" 与 NaN；在读的那一侧迁移之后两者都正常`
  )

  await second.close()
  const passed = results.filter(Boolean).length
  console.log(`\n自检结果：${passed}/${results.length} 项通过`)
  return passed === results.length ? 0 : 1
}

async function demo(): Promise<void> {
  const handle = await createSaver()
  const question = process.argv[2] ?? REQUEST
  const cfg = { configurable: { thread_id: process.env.THREAD_ID ?? `demo-${Date.now()}` } }
  const graph = buildGraph({ checkpointer: handle.saver })
  const state = (await graph.invoke(
    {
      messages: [...makeHistory(11), { role: 'user', content: question }],
      attachments: [ATTACHMENT],
    },
    cfg
  )) as GraphState
  console.log(`问：${question}\n`)
  console.log(`存储：${handle.kind}｜线程：${cfg.configurable.thread_id}`)
  console.log(`历史：压到 ${state.messages.length} 条；摘要：${state.summary}\n`)
  console.log(`答：\n${state.messages.at(-1)?.content}`)
  await handle.close()
}

const exitCode = process.env.SELFTEST === '1' ? await selfTest() : (await demo(), 0)
process.exit(exitCode)
