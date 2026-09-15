/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十四件事，打印勾叉后按结果退出。
 *
 * 今天全部离线、全部可复现：两个演示 server 就在本仓库里、不联网，
 * 断言比的是工具条数、名字、错误码与结果内容——没有一项去比耗时。
 * 唯一会变的东西是端口占用情况，所以 HTTP 那个 server 只起一次、末尾关掉。
 */
import { stdout } from 'node:process'
import { newSession, type Session } from './session-factory.js'
import { runTurn } from './turn.js'
import { createProvider } from './providers/index.js'
import { SessionLog } from './session/log.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { passGate, type ApprovalAnswer, type ApprovalRequest } from './kernel/approval.js'
import type { ToolCall, ToolContext } from './kernel/types.js'
import { MAX_RESULT_CHARS } from './kernel/truncate.js'
import { LineFramer } from './mcp/transport.js'
import { StdioTransport } from './mcp/stdio.js'
import { HttpTransport, encodeHeaderValue } from './mcp/http.js'
import { McpClient } from './mcp/client.js'
import { McpMount, namespacedName } from './mcp/mount.js'
import { PROTOCOL_VERSION, withMeta } from './mcp/protocol.js'
import { NOTES_SERVER, DEFAULT_TICKETS_URL } from './mcp/servers.js'
import { startTicketServer } from './servers/tickets-http.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const ctx: ToolContext = {
  cwd: REPO_DIR,
  signal: new AbortController().signal,
  log: () => {},
}

const notesSpec = {
  alias: 'notes',
  kind: 'stdio' as const,
  command: process.execPath,
  args: [NOTES_SERVER],
}
const ticketsSpec = { alias: 'tickets', kind: 'http' as const, url: DEFAULT_TICKETS_URL }

async function main(): Promise<void> {
  const server = await startTicketServer()

  // 1. 分帧：一条报文从中间劈开喂进去要能拼回来，而半行必须留在缓冲里
  const framer = new LineFramer()
  const first = framer.push('{"jsonrpc":"2.0","id":1,"resu')
  const second = framer.push('lt":{"ok":true}}\n{"id":2}\n{"id":3}')
  const rest = framer.flush()
  check(
    first.length === 0 &&
      second.length === 2 &&
      JSON.parse(second[0] as string).result.ok === true &&
      rest.length === 1 &&
      JSON.parse(rest[0] as string).id === 3,
    `半行报文：第一块吐 ${first.length} 行（全是半行），第二块吐 ${second.length} 行，最后 flush 出 ${rest.length} 行`
  )

  // 2. stdio + 翻页：笔记库每页只回 2 个，判据是 nextCursor 缺失才结束
  const notesClient = new McpClient(
    new StdioTransport({ command: process.execPath, args: [NOTES_SERVER] })
  )
  await notesClient.start()
  const notesTools = await notesClient.listTools()
  check(
    notesTools.length === 3 &&
      notesTools.map((t) => t.name).join(',') === 'search,read_note,list_tags',
    `stdio 翻页：每页 2 个，翻完拿到 ${notesTools.length} 个工具（${notesTools.map((t) => t.name).join('、')}）`
  )

  // 3. Streamable HTTP：tools/list 走的是普通 JSON 那条路
  const httpClient = new McpClient(new HttpTransport({ url: DEFAULT_TICKETS_URL }))
  await httpClient.start()
  const ticketTools = await httpClient.listTools()
  check(
    ticketTools.length === 2 && ticketTools.map((t) => t.name).join(',') === 'search,close_ticket',
    `HTTP tools/list：拿到 ${ticketTools.length} 个工具（${ticketTools.map((t) => t.name).join('、')}）`
  )

  // 4. HTTP 的 tools/call 走事件流：中间夹着通知，带 id 的那条才是响应
  const before = httpClient.notifications
  const called = await httpClient.callTool('search', { query: 'divide' })
  check(
    httpClient.notifications - before === 1 &&
      called.isError !== true &&
      (called.content?.[0]?.text ?? '').includes('T-1001'),
    `HTTP tools/call 走 SSE：收到 ${httpClient.notifications - before} 条通知 + 1 条按 id 配对的响应`
  )

  // 5. 命名空间：两个 search 撞名，前缀来自我们自己的别名而不是 server 自报的名字
  const mount = new McpMount()
  await mount.connect([notesSpec, ticketsSpec])
  const names = mount.list().map((e) => e.localName)
  check(
    names.includes('mcp__notes__search') &&
      names.includes('mcp__tickets__search') &&
      new Set(names).size === names.length &&
      names.length === 5,
    `命名空间：两个 search 变成 ${names.length} 个互不冲突的本地名（${names.join('、')}）`
  )

  // 6. 反查走表不走字符串切分，而且发回 server 的是原名
  const entry = mount.entryOf('mcp__tickets__close_ticket')
  const longName = namespacedName(
    'a-very-long-alias-name-for-testing',
    'a_tool_with_a_long_name_too'
  )
  check(
    entry?.alias === 'tickets' &&
      entry.toolName === 'close_ticket' &&
      longName.length === 64 &&
      longName !==
        namespacedName('a-very-long-alias-name-for-testing', 'a_tool_with_a_long_name_xxx'),
    `反查：${entry?.localName} 指回 ${entry?.alias}:${entry?.toolName}；超长名截断到 ${longName.length} 字符后靠哈希保住唯一性`
  )

  // 7. 远端工具进本地清单之后，循环眼里它和本地工具没有区别
  const session = newSession(() => {}, await SessionLog.create(), { mcp: mount })
  const local = session.registry.list().filter((t) => !t.name.startsWith('mcp__')).length
  const remote = session.registry.list().filter((t) => t.name.startsWith('mcp__')).length
  check(
    local === 8 && remote === 5 && session.registry.size === 13,
    `工具清单：${local} 个本地工具 + ${remote} 个远端工具 = ${session.registry.size} 个，注册表一行都没改`
  )

  // 8. 远端结果照样走 D3 那条截断：预算是一份，不因为工具在别人家就多给
  const big: ToolCall = {
    id: 'c1',
    name: 'mcp__notes__read_note',
    args: JSON.stringify({ title: 'big-dump' }),
  }
  const truncated = await session.registry.execute(big, ctx)
  check(
    truncated.ok &&
      truncated.content.length <= MAX_RESULT_CHARS + 200 &&
      truncated.meta?.truncated === true &&
      truncated.content.includes('已截断'),
    `远端长结果被截到 ${truncated.content.length} 字符（上限 ${MAX_RESULT_CHARS}），走的是本地那条预算`
  )

  // 9. 信任边界：server 自己声明 readOnlyHint 为真的 search 照样要过审批门
  const asked: string[] = []
  const denying = async (request: ApprovalRequest): Promise<ApprovalAnswer> => {
    asked.push(request.tool.name)
    return { approved: false, scope: 'once', note: '用户这次不让查外部系统' }
  }
  const searchCall: ToolCall = {
    id: 'c2',
    name: 'mcp__notes__search',
    args: JSON.stringify({ query: '除数为 0' }),
  }
  const gated = newSession(() => {}, await SessionLog.create(), { mcp: mount })
  const blocked = await runOneTool(gated, searchCall, denying)
  check(
    asked.length === 1 &&
      asked[0] === 'mcp__notes__search' &&
      !blocked.ok &&
      blocked.meta?.blockedBy === 'approval' &&
      // 反向确认这一项不是恒真：server 确实声明了自己只读，而我们确实没采信
      mount.entryOf('mcp__notes__search')?.def.annotations?.readOnlyHint === true &&
      session.registry.get('mcp__notes__search')?.readOnly === false,
    `信任边界：server 声明 readOnlyHint 为真的 ${asked[0]} 照样停下来问，拒绝后回灌的是 ok 为 false 的结果`
  )

  // 10. 批准之后真的调得通，而且结果来自那个远端 server
  const allowed = await runOneTool(gated, searchCall, async () => ({
    approved: true,
    scope: 'once',
  }))
  check(
    allowed.ok && allowed.content.includes('divide-convention') && allowed.meta?.alias === 'notes',
    `批准之后：拿到笔记库的真实结果（命中 divide-convention），meta 记着来自 ${String(allowed.meta?.alias)}`
  )

  // 11. 头体不一致必须被拒：把 Mcp-Name 头改坏，服务端回 -32020
  const mismatch = await fetch(DEFAULT_TICKETS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': encodeHeaderValue('close_ticket'), // 头说 close_ticket
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: withMeta({ name: 'search', arguments: { query: 'divide' } }), // 体说 search
    }),
  })
  const mismatchBody = (await mismatch.json()) as { error?: { code?: number } }
  check(
    mismatch.status === 400 && mismatchBody.error?.code === -32020,
    `头体不一致：Mcp-Name 头写 close_ticket、体里写 search，服务端回 ${mismatch.status} 加 ${mismatchBody.error?.code}`
  )

  // 12. 失败隔离：一个连不上的 server 进掉线表，另一个照常；调它的工具不抛异常
  const partial = new McpMount()
  await partial.connect([
    notesSpec,
    { alias: 'tickets', kind: 'http', url: 'http://127.0.0.1:3199/mcp', timeoutMs: 500 },
  ])
  // 连不上的 server 一个工具都没挂上，所以它的工具压根不在清单里——
  // 模型看不到就不会调。真去调也只是拿到一条 ok 为 false 的结果，不是异常
  const dead = await partial.call('mcp__tickets__search', { query: 'x' })
  check(
    partial.down.has('tickets') &&
      partial.list().length === 3 &&
      partial.list().every((e) => e.alias === 'notes') &&
      !dead.ok &&
      dead.content.includes('没有名为'),
    `失败隔离：tickets 掉线（${partial.down.get('tickets')}），笔记库的 3 个工具照常可用；` +
      '调它的工具拿到的是一条 ok 为 false 的结果而不是异常'
  )

  // 13. 超时：一个收得到却永远不回的 server，必须在超时后失败而不是一直挂着
  const mute = new McpClient(
    new StdioTransport({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
    300
  )
  await mute.start()
  const timedOut = await mute
    .listTools()
    .then(() => '没有超时')
    .catch((error: Error) => error.message)
  await mute.close()
  check(
    timedOut.includes('超时'),
    `永不回复的 server：tools/list 在 300ms 后报「${timedOut}」，而不是一直挂着`
  )

  // 14. 端到端：离线剧本里模型连调两个远端工具，一轮跑完两次都真的执行了
  await seedRepo()
  const e2e = newSession(() => {}, await SessionLog.create(), { mcp: mount })
  const summary = await runTurn({
    session: e2e,
    provider: createProvider(),
    line: '动手之前先查查团队笔记和工单',
    write: () => {},
    out: () => {},
    approve: async () => ({ approved: true, scope: 'once' }),
    tty: false,
  })
  const used = summary.summary.tools.map((t) => t.name)
  check(
    used.length === 2 &&
      used[0] === 'mcp__notes__search' &&
      used[1] === 'mcp__tickets__search' &&
      summary.summary.tools.every((t) => t.ok),
    `端到端：一轮里依次调了 ${used.join(' → ')}，两个远端工具都真的执行了`
  )

  await mount.close()
  await partial.close()
  await notesClient.close()
  await httpClient.close()
  server.close()

  out(`${passed}/${passed + failed} 通过`)
  out(
    '（全部离线可复现：两个演示 server 就在 src/servers/ 下、不联网，' +
      '断言比的是工具条数、名字、错误码与结果内容，没有一项去比耗时。' +
      `唯一的外部条件是本机 ${new URL(DEFAULT_TICKETS_URL).port} 端口空着）`
  )
  if (failed > 0) process.exitCode = 1
}

/** 跑一次工具调用，走注册表 + 审批门，与循环里那条路径完全一致 */
async function runOneTool(
  session: Session,
  call: ToolCall,
  approve: (request: ApprovalRequest) => Promise<ApprovalAnswer>
): Promise<import('./kernel/types.js').ToolResult> {
  const tool = session.registry.get(call.name)
  if (!tool) throw new Error(`没有工具 ${call.name}`)
  const blocked = await passGate(call, tool, { state: session.permissions, approve })
  return blocked ?? session.registry.execute(call, ctx)
}

await main()
