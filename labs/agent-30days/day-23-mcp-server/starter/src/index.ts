import 'dotenv/config'
import { runAgent } from './agent'
import { shouldUseMcp, toFunctionTool, type McpToolDescriptor } from './bridge'
import { connectMcp, type McpConnection } from './mcp-client'

const ITEMS: [string, string][] = [
  ['MCP server 起得来、initialize 握手成功', 'server 没起来或握手失败'],
  ['tools/list 列出两个工具，schema 带格式约束', 'track_shipment 还没注册（练习 1）'],
  ['MCP tool 翻译成 function calling schema', 'toFunctionTool 还没搬运 inputSchema（练习 2）'],
  [
    'Agent 通过 MCP tools/call 真的调到工具',
    'callTool 还没走 MCP（练习 3），或 schema 是空的（练习 2）',
  ],
  ['工具报错原样回传，模型自己改对参数', '错误被吞掉了，模型看不到纠错说明（练习 4）'],
  ['选型判据：三条都不命中就别上 MCP', 'shouldUseMcp 恒返回「上」（练习 5）'],
]

const results: boolean[] = []

function check(n: number, ok: boolean, detail: string): void {
  results.push(ok)
  const [label, hint] = ITEMS[n - 1]
  console.log(`[${n}/6] ${label}：${detail} ${ok ? '✅' : `❌ ${hint}`}`)
}

function trace(line: string): void {
  console.log(`      ${line}`)
}

async function selfTest(conn: McpConnection): Promise<number> {
  // [1] 握手：server 自报身份、声明自己提供 tools 这一类原语
  const ok1 = conn.serverInfo.name === 'shop-tools' && conn.capabilities.includes('tools')
  check(
    1,
    ok1,
    `server=${conn.serverInfo.name}@${conn.serverInfo.version}，声明的原语 [${conn.capabilities.join(', ')}]`
  )

  // [2] 发现：tools/list 拿到的是 JSON Schema，连 pattern 这种格式约束都原样带过来了
  const names = conn.mcpTools.map((t) => t.name).sort()
  const orderTool = conn.mcpTools.find((t) => t.name === 'query_order')
  const orderIdSchema = orderTool?.inputSchema.properties?.order_id as
    { pattern?: string } | undefined
  const ok2 =
    names.length === 2 &&
    names[0] === 'query_order' &&
    names[1] === 'track_shipment' &&
    orderIdSchema?.pattern !== undefined
  check(
    2,
    ok2,
    `tools/list = [${names.join(', ')}]，order_id.pattern = ${orderIdSchema?.pattern ?? '缺失'}`
  )

  // [3] 翻译：同一份 schema 换个外壳发给模型——这一步便宜，所以 MCP 不是 function calling 的替代品
  const sample: McpToolDescriptor = {
    name: 'query_order',
    description: '按订单号查询一笔订单。',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string', pattern: '^SO\\d{8}$' } },
      required: ['order_id'],
    },
  }
  const fn = toFunctionTool(sample)
  const real = conn.functionTools.find((t) => t.function.name === 'query_order')
  const ok3 =
    fn.type === 'function' &&
    fn.function.name === 'query_order' &&
    fn.function.description.length > 0 &&
    JSON.stringify(fn.function.parameters.properties) ===
      JSON.stringify(sample.inputSchema.properties) &&
    fn.function.parameters.required[0] === 'order_id' &&
    real?.function.parameters.required.includes('order_id') === true
  check(
    3,
    ok3,
    `翻译后 parameters.required = ${JSON.stringify(fn.function.parameters.required)}，` +
      `实际发给模型的 query_order.required = ${JSON.stringify(real?.function.parameters.required ?? [])}`
  )

  // [4] 打通：模型选工具 → MCP tools/call → 结果回填 → 模型收尾
  const happy = await runAgent('帮我查一下订单 SO20260901 现在什么状态', conn, trace)
  const ok4 =
    happy.calls.length === 1 &&
    happy.calls[0].name === 'query_order' &&
    happy.calls[0].ok &&
    happy.answer.includes('已发货')
  check(4, ok4, `调用 ${happy.calls.length} 次，最终回答「${happy.answer}」`)

  // [5] 纠错：订单号格式合法但查无此单，报错文案原样回传，模型换一个订单号再来一次
  const retry = await runAgent('帮我查一下订单 SO20260999 现在什么状态', conn, trace)
  const ok5 =
    retry.calls.length === 2 &&
    !retry.calls[0].ok &&
    retry.calls[0].text.includes('不存在') &&
    retry.calls[1].ok &&
    retry.calls[1].args.order_id === 'SO20260901' &&
    retry.answer.includes('已发货')
  check(
    5,
    ok5,
    `第一次 ${retry.calls[0]?.ok ? '成功' : '失败'}，共调用 ${retry.calls.length} 次，` +
      `第二次参数 ${JSON.stringify(retry.calls[1]?.args ?? {})}`
  )

  // [6] 判据：默认答案是「不上 MCP」
  const inHouse = shouldUseMcp({
    name: '只给自己这个 Agent 用的订单查询',
    hostCount: 1,
    ownedByOthers: false,
    hotSwappable: false,
  })
  const thirdParty = shouldUseMcp({
    name: '风控团队维护的黑名单查询',
    hostCount: 2,
    ownedByOthers: true,
    hotSwappable: true,
  })
  const ok6 = !inHouse.use && thirdParty.use && thirdParty.reasons.length === 3
  check(
    6,
    ok6,
    `自家能力 → ${inHouse.use ? '上 MCP' : '直接写 function calling'}；` +
      `三方能力 → ${thirdParty.use ? `上 MCP（命中 ${thirdParty.reasons.length} 条）` : '直接写 function calling'}`
  )

  const passed = results.filter(Boolean).length
  console.log(`\n=== 自检结束：${passed}/${results.length} 项通过 ===`)
  return passed === results.length ? 0 : 1
}

async function main(): Promise<void> {
  console.log('=== D23：连接 MCP server（stdio 子进程）===')
  const conn = await connectMcp()

  try {
    if (process.env.SELFTEST === '1') {
      process.exitCode = await selfTest(conn)
      return
    }
    const question = process.argv[2] ?? '帮我查一下订单 SO20260901 的物流到哪了'
    console.log(
      `发现 ${conn.functionTools.length} 个工具：${conn.mcpTools.map((t) => t.name).join(', ')}`
    )
    console.log(`问题：${question}`)
    const run = await runAgent(question, conn, (line) => console.log(`  ${line}`))
    console.log(`回答：${run.answer}`)
  } finally {
    await conn.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
