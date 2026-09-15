import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from './server.js'

// 自测入口：在同一个进程里用一对内存传输把客户端和服务端接起来，
// 逐项打印现象并给 ✅/❌。starter 原样跑会有几项是 ❌，那就是你的练习点。

type Check = { name: string; ok: boolean; detail: string }

const checks: Check[] = []
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail}`)
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content.map((c) => c.text ?? '').join('\n')
}

async function main(): Promise<void> {
  const server = buildServer()
  const client = new Client({ name: 'd2-selftest', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  // 1. 工具清单
  const listed = await client.listTools()
  const names = listed.tools.map((t) => t.name).sort()
  const weather = listed.tools.find((t) => t.name === 'get_weather')
  const fx = listed.tools.find((t) => t.name === 'convert_currency')
  record(
    '1. tools/list 返回两个工具，且都带输入与输出 schema',
    names.join(',') === 'convert_currency,get_weather' &&
      Boolean(weather?.outputSchema) &&
      Boolean(fx?.outputSchema),
    `工具清单：${names.join(', ') || '（空）'}；get_weather 有 outputSchema：${Boolean(
      weather?.outputSchema
    )}；convert_currency 有 outputSchema：${Boolean(fx?.outputSchema)}`
  )

  // 2. 两个工具都带注解
  const weatherAnn = weather?.annotations ?? {}
  const fxAnn = fx?.annotations ?? {}
  record(
    '2. 两个工具都声明了 readOnlyHint 与 idempotentHint',
    weatherAnn.readOnlyHint === true &&
      weatherAnn.idempotentHint === true &&
      fxAnn.readOnlyHint === true &&
      fxAnn.idempotentHint === true,
    `get_weather 注解：${JSON.stringify(weatherAnn)}；convert_currency 注解：${JSON.stringify(fxAnn)}`
  )

  // 3. 正常调用返回结构化内容
  const ok = await client.callTool({ name: 'get_weather', arguments: { city: '上海' } })
  const structured = (ok as { structuredContent?: Record<string, unknown> }).structuredContent
  record(
    '3. get_weather 正常调用返回 structuredContent',
    typeof structured?.celsius === 'number' && typeof structured?.conditions === 'string',
    `structuredContent = ${JSON.stringify(structured ?? null)}`
  )

  // 4. 未知城市走执行错误，且文案对模型有用
  const unknownCity = await client.callTool({ name: 'get_weather', arguments: { city: '火星' } })
  const unknownText = textOf(unknownCity)
  record(
    '4. 未知城市返回 isError 且文案里列出了可用城市',
    unknownCity.isError === true && unknownText.includes('可用城市'),
    `isError = ${String(unknownCity.isError)}；文案 = ${unknownText.replace(/\n/g, ' ')}`
  )

  // 5. 汇率换算算对
  const fxOk = await client.callTool({
    name: 'convert_currency',
    arguments: { amount: 100, from: 'USD', to: 'CNY' },
  })
  const fxStructured = (fxOk as { structuredContent?: Record<string, unknown> }).structuredContent
  record(
    '5. convert_currency 把 100 USD 换成 712 CNY',
    fxStructured?.converted === 712,
    `structuredContent = ${JSON.stringify(fxStructured ?? null)}`
  )

  // 6. 非法参数走执行错误，而且文案要对模型有用。
  //    注意：光让 NaN 一路传到输出 schema 校验那里、由 SDK 兜成一条报错，不算「处理了错误」——
  //    模型拿到的是一段 schema 校验堆栈，它读不出该改哪个参数。所以这里同时断言
  //    文案里不能出现 SDK 的 "validation error"。
  const badCases: { label: string; args: Record<string, unknown> }[] = [
    { label: '金额为负', args: { amount: -5, from: 'USD', to: 'CNY' } },
    { label: '未知币种', args: { amount: 10, from: 'USD', to: 'XYZ' } },
  ]
  const badResults: string[] = []
  let allHandled = true
  for (const c of badCases) {
    try {
      const r = await client.callTool({ name: 'convert_currency', arguments: c.args })
      const text = textOf(r)
      const handled = r.isError === true && !text.includes('validation error')
      if (!handled) allHandled = false
      badResults.push(`${c.label}: isError=${String(r.isError)} ${text.replace(/\n/g, ' ')}`)
    } catch (err) {
      allHandled = false
      badResults.push(`${c.label}: 抛出异常 ${String(err)}`)
    }
  }
  record(
    '6. 非法参数返回对模型有用的 isError，而不是抛异常或 schema 报错',
    allHandled,
    badResults.join('；')
  )

  // 7. 未知工具名：规范要求回 JSON-RPC -32602（协议错误）。
  //    但 SDK 1.30.0 的 McpServer 会自己 catch 掉这个 McpError，压成一条 isError 结果，
  //    文案里保留了 "MCP error -32602"。这是 SDK 与规范的一处真实偏差，正文里有解释。
  let observed = ''
  try {
    const r = await client.callTool({ name: 'no_such_tool', arguments: {} })
    observed = `以 isError=${String(r.isError)} 返回，文案：${textOf(r)}`
  } catch (err) {
    observed = `抛出异常：code=${String((err as { code?: number }).code ?? '')} ${String(err)}`
  }
  record(
    '7. 未知工具名能被识别为 -32602 协议错误',
    observed.includes('-32602'),
    observed || '既没抛异常也没返回错误'
  )

  await client.close()
  await server.close()

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length} 项。`)
  if (failed.length > 0) {
    console.log(`还差：${failed.map((c) => c.name).join('；')}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
