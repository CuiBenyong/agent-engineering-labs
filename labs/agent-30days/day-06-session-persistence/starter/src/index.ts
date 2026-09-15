import 'dotenv/config'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string
  name: string
  args: Record<string, string>
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

/**
 * 会话元信息。注意这里没有 system 消息——系统提示词永远不进持久化历史，
 * 每次用当前时间现拼（不然三天后读出来，模型以为今天还是三天前）。
 */
interface SessionMeta {
  id: string
  parentId: string | null
  /** 从父会话的第几条消息切出来的；不是分叉出来的会话为 0 */
  forkedAt: number
  /** 压缩水位：原始历史的前多少条已经被摘要进 digest 了 */
  compressedUpTo: number
  /** 压缩产生的滚动摘要，是派生数据，原始历史一条都不会被它改写 */
  digest: string
  createdAt: string
}

interface Session {
  meta: SessionMeta
  /** 原始历史：只追加、永不改写。压缩不会动它，只会推高 compressedUpTo */
  messages: Message[]
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const MAX_TOKENS = 4000 // 给历史单独划的预算，不是模型窗口上限
const TRIGGER_RATIO = 0.7 // 用到七成就压，留出摘要调用失败的抢救时间
const KEEP_RECENT = 8 // 最近 8 条保留原文：模型最依赖刚发生的事
const STORE_DIR = resolve(process.cwd(), '.sessions')

// ---------------------------------------------------------------------------
// 存储层：只追加的 JSONL + 一个元信息文件
// ---------------------------------------------------------------------------

function paths(id: string): { jsonl: string; meta: string } {
  return { jsonl: resolve(STORE_DIR, `${id}.jsonl`), meta: resolve(STORE_DIR, `${id}.meta.json`) }
}

function saveMeta(meta: SessionMeta): void {
  mkdirSync(STORE_DIR, { recursive: true })
  writeFileSync(paths(meta.id).meta, JSON.stringify(meta, null, 2), 'utf8')
}

/**
 * 往会话里追加一条消息。内存那一半已经写好了，磁盘那一半是你的活。
 *
 * 练习 3：把这条消息按 JSONL 追加到 `paths(session.meta.id).jsonl`——
 * 一行一条 JSON，只追加不改写，记得先 mkdirSync 建目录。
 * 提示：建议把 seq（第几条）和 ts（时间戳）也写进去，排查问题时非常有用。
 *
 * 挖空默认：只写内存不写盘。程序照跑，但下面第 3 步「模拟重启」会从磁盘读到 0 条。
 */
function appendMessage(session: Session, message: Message): void {
  session.messages.push(message)

  // TODO: 用 appendFileSync 把 message 追加成 JSONL 的一行
  void appendFileSync
}

function createSession(id: string, parentId: string | null, forkedAt: number): Session {
  mkdirSync(STORE_DIR, { recursive: true })
  const meta: SessionMeta = {
    id,
    parentId,
    forkedAt,
    compressedUpTo: 0,
    digest: '',
    createdAt: new Date().toISOString(),
  }
  saveMeta(meta)
  writeFileSync(paths(id).jsonl, '', 'utf8')
  return { meta, messages: [] }
}

function loadSession(id: string): Session | null {
  const { jsonl, meta } = paths(id)
  if (!existsSync(meta)) return null

  const parsedMeta = JSON.parse(readFileSync(meta, 'utf8')) as SessionMeta
  const lines = existsSync(jsonl)
    ? readFileSync(jsonl, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
    : []
  const messages = lines.map((line) => {
    const record = JSON.parse(line) as Message & { seq: number; ts: string }
    return {
      role: record.role,
      content: record.content,
      toolCalls: record.toolCalls,
      toolCallId: record.toolCallId,
    }
  })
  return { meta: parsedMeta, messages: validateTail(messages) }
}

/**
 * 恢复时的完整性校验：进程可能在「模型返回了 tool_calls、工具结果还没写回」之间崩掉，
 * 磁盘上就留下一条悬空的调用请求。原样发出去，多数厂商的 API 直接返回 400。
 * 这里补一条「执行被中断」的 tool 结果，让模型自己重新发起调用（复用 D5 的错误回传）。
 */
function validateTail(messages: Message[]): Message[] {
  const last = messages[messages.length - 1]
  if (!last || !last.toolCalls || last.toolCalls.length === 0) return messages

  const repaired = [...messages]
  for (const call of last.toolCalls) {
    repaired.push({
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify({ error: '工具执行被中断，请重新调用' }),
    })
  }
  console.log('[修复] 尾部有未配对的 tool_calls，已补上「执行被中断」的结果')
  return repaired
}

// ---------------------------------------------------------------------------
// 上下文工程：估算、切口对齐、压缩
// ---------------------------------------------------------------------------

/**
 * 练习 1：粗估这一批消息占多少 token。
 * 阈值判断不需要精确值，别为此引入分词器依赖——按 D1 的换算，中文大约 1.4 个
 * 字符一个 token，这里干脆「一个字符算一个 token」，故意往高了估：估低了压缩
 * 阈值永远触发不了。另外每条消息本身有角色、分隔符的开销，再加 4 个 token 的常数。
 *
 * 挖空默认：恒为 0。程序照跑，但压缩的阈值判断永远不成立，历史会一直涨。
 */
function estimateTokens(messages: Message[]): number {
  // TODO: 把每条 content 的长度折算成 token 加起来
  void messages
  return 0
}

/**
 * 往前找到最近一个不是 tool 结果的位置，保证切口落在一轮的开头。
 * 切在 assistant 的 tool_calls 和它的 tool 结果之间，下一次请求就有了悬空调用。
 */
function alignToTurnStart(messages: Message[], index: number): number {
  let i = index
  while (i > 0 && messages[i].role === 'tool') i--
  return i
}

/** 系统提示词每次现拼，绝不进持久化历史——里面的「现在时间」是活的 */
function buildSystemPrompt(now: Date): string {
  return [
    '你是「某电商平台」的售后助手。',
    '',
    '【能力边界】',
    '- 只回答订单、退换货、物流相关问题',
    '',
    '【输出要求】',
    '- 每次回复不超过 3 句话',
    '',
    '【当前上下文】',
    `- 现在时间：${now.toISOString().slice(0, 16).replace('T', ' ')}`,
  ].join('\n')
}

/** 真正发给模型的那一份：现拼的系统提示词 + 摘要（如果有）+ 压缩水位之后的原文 */
function activeMessages(session: Session, now: Date): Message[] {
  const live = session.messages.slice(session.meta.compressedUpTo)
  const digest: Message[] = session.meta.digest
    ? [{ role: 'user', content: `【早期对话摘要】${session.meta.digest}` }]
    : []
  return [{ role: 'system', content: buildSystemPrompt(now) }, ...digest, ...live]
}

/**
 * 练习 2：超过预算的七成就把早期消息摘要成一条。步骤：
 *   1. 算出 activeMessages 的 token 数，低于 MAX_TOKENS * TRIGGER_RATIO 就直接 return false。
 *   2. 取 session.messages.slice(session.meta.compressedUpTo) 作为"还没被压过"的那一段，
 *      用给好的 alignToTurnStart 把切口对齐到一轮开头（保留最近 KEEP_RECENT 条原文）。
 *   3. 调 summarize(session.meta.digest, 被压掉的那一段) 拿到新摘要，
 *      写回 session.meta.digest、把 compressedUpTo 加上 cut，再 saveMeta 落盘。
 *   4. 打印一行压缩前后的对比，形如
 *      `[压缩] 29 条 / 1440 token → 10 条 / 478 token（降幅 67%）`。
 *
 * 关键约束：**原始 JSONL 一个字都不能动**，只推高 compressedUpTo、只改写 digest。
 * 压缩是有损且不可逆的，留着原文才有可能从被压掉的位置分叉回来。
 *
 * 挖空默认：什么都不做。程序照跑，但历史一条也不会变短。
 */
async function compressIfNeeded(session: Session): Promise<boolean> {
  // TODO: 按上面四步实现
  void session
  void alignToTurnStart
  void summarize
  void saveMeta
  void MAX_TOKENS
  void TRIGGER_RATIO
  void KEEP_RECENT
  return false
}

// ---------------------------------------------------------------------------
// 会话分叉
// ---------------------------------------------------------------------------

/**
 * 练习 4：分叉 = 复制前 k 条 + 记住从哪来。父会话只读，这是它和「回滚」的根本区别。
 * 要点：先用 alignToTurnStart 把切点对齐到一轮开头，再把前 cut 条**深拷贝**
 * （structuredClone）之后逐条 appendMessage 进新会话，让它们也落到新会话自己的 JSONL 里。
 *
 * 挖空默认：直接把父会话的数组交给新会话——既没截断也没拷贝。
 * 程序照跑，但两条分支从此共用同一个数组，往子会话追加一条，父会话也跟着变长。
 */
function forkSession(parent: Session, atIndex: number): Session {
  const child = createSession(`s-${randomUUID().slice(0, 8)}`, parent.meta.id, atIndex)
  // TODO: 换成「对齐切点 → structuredClone 前 cut 条 → 逐条 appendMessage」
  child.messages = parent.messages
  void structuredClone
  return child
}

// ---------------------------------------------------------------------------
// 工具（本地执行，不是网络出口）
// ---------------------------------------------------------------------------

function runTool(call: ToolCall): Record<string, unknown> {
  // 故意返回一坨结构完整的 JSON：真正撑爆历史的就是这种工具结果
  return {
    orderId: `SO-${call.id}`,
    status: '运输中',
    eta: '2026-09-05',
    carrier: '示例快运',
    items: [
      { sku: 'A-1001', name: '示例商品甲', qty: 1, price: 129 },
      { sku: 'B-2002', name: '示例商品乙', qty: 2, price: 59 },
    ],
    timeline: [
      { at: '2026-09-01 10:12', text: '已下单' },
      { at: '2026-09-02 08:30', text: '已出库' },
      { at: '2026-09-03 19:45', text: '到达中转中心' },
    ],
  }
}

// ---------------------------------------------------------------------------
// 网络出口：只有这两个函数会出网，MOCK=1 时在函数最前面直接返回假数据
// ---------------------------------------------------------------------------

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return ''
}

/** 假模型：从"发给模型的那一份"里找答案，所以摘要有没有保住事实，一问便知 */
function mockReply(messages: Message[]): string {
  const question = lastUserText(messages)
  if (question.includes('住') || question.includes('刚才')) {
    const haystack = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join(' ')
    const hit = /我住在?([^，。,\s]+)/.exec(haystack)
    return hit
      ? `这是离线模拟回复：你之前说过你住${hit[1]}，收货地址就按这个来。`
      : '这是离线模拟回复：我在现有上下文里没找到你说过住哪，方便再说一次吗？'
  }
  return `这是离线模拟回复：已经帮你查过了，包裹预计明天送达。（问题：${question.slice(0, 12)}）`
}

async function callModel(messages: Message[]): Promise<string> {
  if (process.env.MOCK === '1') {
    return mockReply(messages)
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`模型返回 HTTP ${res.status}`)
  const json = (await res.json()) as { choices: { message: { content: string } }[] }
  return json.choices[0].message.content
}

/** 滚动摘要：把上一份摘要和新压掉的那一段合并成一份新的 */
async function summarize(previous: string, older: Message[]): Promise<string> {
  if (process.env.MOCK === '1') {
    const facts = older
      .filter((m) => m.role === 'user')
      .map((m) => /我住在?[^，。,\s]+/.exec(m.content)?.[0])
      .filter((fact): fact is string => Boolean(fact))
    const rounds = older.filter((m) => m.role === 'user').length
    const parts = [previous, `用户与助手完成了 ${rounds} 轮订单查询，包裹均在运输中。`]
    // 用户明确声明过的事实必须写进摘要，不能当过程扔掉
    if (facts.length > 0) parts.push(`用户明确说过：${[...new Set(facts)].join('、')}。`)
    return parts.filter(Boolean).join(' ')
  }

  const instruction: Message = {
    role: 'user',
    content: [
      '把下面的对话压成一段摘要，保留用户明确声明过的事实与约束，丢掉中间过程。',
      previous ? `已有摘要：${previous}` : '',
      ...older.map((m) => `${m.role}: ${m.content.slice(0, 400)}`),
    ]
      .filter(Boolean)
      .join('\n'),
  }
  return callModel([instruction])
}

// ---------------------------------------------------------------------------
// 一轮对话
// ---------------------------------------------------------------------------

async function runTurn(session: Session, userText: string, withTool: boolean): Promise<string> {
  appendMessage(session, { role: 'user', content: userText })

  if (withTool) {
    // 一次工具调用往历史里塞两条：调用请求 + 返回结果
    const call: ToolCall = { id: `c${session.messages.length}`, name: 'query_order', args: {} }
    appendMessage(session, { role: 'assistant', content: '', toolCalls: [call] })
    appendMessage(session, {
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify(runTool(call)),
    })
  }

  const text = await callModel(activeMessages(session, new Date()))
  appendMessage(session, { role: 'assistant', content: text })
  await compressIfNeeded(session)
  return text
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

function describe(session: Session): string {
  const active = activeMessages(session, new Date())
  return [
    `会话 ${session.meta.id}`,
    `  原始历史 ${session.messages.length} 条（只追加）`,
    `  压缩水位 ${session.meta.compressedUpTo}，摘要 ${session.meta.digest.length} 字`,
    `  实际发给模型 ${active.length} 条 / ${estimateTokens(active)} token`,
    `  父会话 ${session.meta.parentId ?? '无'}，分叉自第 ${session.meta.forkedAt} 条`,
  ].join('\n')
}

const SEED_QUESTIONS = [
  '我住上海，帮我看看最近的包裹',
  '这单什么时候能到？',
  '能不能改成周末送？',
  '快递单号是多少？',
  '另一单呢？',
  '发票开好了吗？',
  '退货要走什么流程？',
  '换货和退货哪个快？',
  '运费谁出？',
  '大概几天能退到账？',
  '还能改收货地址吗？',
  '帮我确认下最新状态',
]

async function demo(): Promise<void> {
  console.log('[1/5] 重置会话 main…')
  rmSync(STORE_DIR, { recursive: true, force: true })
  const session = createSession('main', null, 0)

  console.log(`[2/5] 灌入 ${SEED_QUESTIONS.length} 轮带工具调用的对话…`)
  for (const question of SEED_QUESTIONS) {
    await runTurn(session, question, true)
  }
  const compressed = session.meta.compressedUpTo > 0
  if (estimateTokens([{ role: 'user', content: '一二三四五六七八九十' }]) === 0) {
    console.log('[练习 1 未完成] estimateTokens 恒为 0，压缩阈值永远不会被触发。')
  }
  if (!compressed) {
    console.log('[练习 2 未完成] 历史一条没短：compressIfNeeded 没有把早期消息摘要掉。')
  }
  console.log(describe(session))

  console.log('[3/5] 模拟重启：丢掉内存对象，从磁盘重新加载…')
  const restored = loadSession('main')
  const working = restored && restored.messages.length > 0 ? restored : session
  if (working === session) {
    console.log(
      '[练习 3 未完成] 从磁盘读到 0 条消息——appendMessage 还没有真的落盘（下面改用内存里的会话继续演示）。'
    )
  } else {
    console.log(
      `[恢复] 从磁盘读到 ${working.messages.length} 条消息，压缩水位 ${working.meta.compressedUpTo}`
    )
  }
  console.log(`助教> ${await runTurn(working, '刚才我说我住哪？', false)}`)

  console.log('[4/5] 从第 4 条分叉出一条新会话…')
  const parentCountBefore = working.messages.length
  const child = forkSession(working, 4)
  console.log(`[分叉] ${child.meta.id} 继承了 ${child.messages.length} 条历史`)
  await runTurn(child, '这条分支上我再问一句', false)

  console.log('[5/5] 校验父会话没有被分叉改动…')
  if (working.messages.length === parentCountBefore) {
    console.log(`[通过] 父会话仍是 ${parentCountBefore} 条，两条分支互不影响。`)
  } else {
    console.log(
      `[练习 4 未完成] 父会话被分叉污染了：${parentCountBefore} 条 → ${working.messages.length} 条，forkSession 需要截断并深拷贝。`
    )
  }
  console.log(`\n提示：会话文件在 ${STORE_DIR}，可以 cat 一下 main.jsonl 看看只追加长什么样。`)
}

function readSessionFlag(args: string[]): { id: string; rest: string[] } {
  const flag = args.find((a) => a.startsWith('--session='))
  return {
    id: flag ? flag.slice('--session='.length) : 'main',
    rest: args.filter((a) => a !== flag),
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (!command) {
    await demo()
    return
  }

  const { id, rest } = readSessionFlag(argv.slice(1))

  if (command === 'chat') {
    const session = loadSession(id)
    if (!session) {
      console.log(`会话 ${id} 不存在，先跑一次 MOCK=1 pnpm start 生成 main。`)
      return
    }
    console.log(`[恢复] 从磁盘读到 ${session.messages.length} 条消息`)
    console.log(`你> ${rest.join(' ')}`)
    console.log(`助教> ${await runTurn(session, rest.join(' ') || '在吗？', false)}`)
    return
  }

  if (command === 'fork') {
    const parent = loadSession(id)
    if (!parent) {
      console.log(`会话 ${id} 不存在。`)
      return
    }
    const child = forkSession(parent, Number(rest[0] ?? 4))
    console.log(`[分叉] ${child.meta.id} 继承了 ${child.messages.length} 条历史`)
    console.log(`用 MOCK=1 pnpm start chat "你好" --session=${child.meta.id} 在新分支上继续。`)
    return
  }

  if (command === 'show') {
    const session = loadSession(rest[0] ?? id)
    console.log(session ? describe(session) : '会话不存在。')
    return
  }

  console.log('用法：pnpm start [chat <文本> | fork <索引> | show <会话 id>] [--session=<id>]')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
