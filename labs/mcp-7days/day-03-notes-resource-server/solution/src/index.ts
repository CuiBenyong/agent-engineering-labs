// 入口：两种跑法。
//   MOCK=1 SELFTEST=1 pnpm start  自测，逐项打印 ✅/❌ 后按结果退出
//   MOCK=1 pnpm start             常驻 stdio，供 Inspector 或你自己的客户端接
//
// 这个 lab 完全离线：数据来自 ../../notes 下的 Markdown，没有任何网络出口，
// 所以 MOCK=1 在这里只是「不要求任何外部服务」的一个约定，两条路径跑的是同一份代码。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server.js'

async function serveStdio(): Promise<void> {
  const server = buildServer()
  // 日志只能走 stderr：stdout 里出现任何非 MCP 消息都会让客户端解析失败
  process.stderr.write('[notes-server] stdio 已就绪，等待客户端\n')
  await server.connect(new StdioServerTransport())
}

interface Check {
  name: string
  ok: boolean
  detail: string
}

async function selftest(): Promise<void> {
  const checks: Check[] = []
  const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildServer()
  const client = new Client({ name: 'selftest-client', version: '0.1.0' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    // 1. 第一页有内容，并且带 nextCursor
    const page1 = await client.listResources()
    record(
      '1. resources/list 第一页有内容且带 nextCursor',
      page1.resources.length > 0 && typeof page1.nextCursor === 'string',
      `${page1.resources.length} 条，nextCursor=${page1.nextCursor ?? '(无)'}`
    )

    // 2. 翻到底：每一页都不重复，最后一页不带 nextCursor
    const seen: string[] = page1.resources.map((r) => r.uri)
    let cursor = page1.nextCursor
    let pages = 1
    let overlapped = false
    while (cursor !== undefined && pages < 20) {
      const next = await client.listResources({ cursor })
      pages += 1
      for (const r of next.resources) {
        if (seen.includes(r.uri)) overlapped = true
        seen.push(r.uri)
      }
      cursor = next.nextCursor
    }
    record(
      '2. 翻页无重复，最后一页不带 nextCursor',
      !overlapped && cursor === undefined && pages >= 2,
      `共 ${pages} 页 ${seen.length} 条，重复=${overlapped}`
    )

    // 3. 读得到正文
    const first = seen[0]
    const read = await client.readResource({ uri: first })
    // contents 是 text 或 blob 二选一的联合类型，取 text 前要先窄化
    const content = read.contents[0]
    const text = content && 'text' in content ? content.text : undefined
    record(
      '3. resources/read 读到笔记正文',
      typeof text === 'string' && text.length > 0,
      `${first} 正文 ${typeof text === 'string' ? text.length : 0} 字`
    )

    // 4. 资源模板里有 uriTemplate
    const templates = await client.listResourceTemplates()
    const tpl = templates.resourceTemplates[0]?.uriTemplate
    record(
      '4. resources/templates/list 返回 uriTemplate',
      typeof tpl === 'string' && tpl.includes('{'),
      `uriTemplate=${tpl ?? '(无)'}`
    )

    // 5. 提示模板返回的消息里含资源引用
    // 用一个只命中一篇的窄标签，这样既验证了资源引用，也验证了筛选真的在筛
    const prompt = await client.getPrompt({
      name: 'digest_by_tag',
      arguments: { tag: 'transport' },
    })
    const links = prompt.messages.filter((m) => m.content.type === 'resource_link')
    const wide = await client.getPrompt({ name: 'digest_by_tag', arguments: { tag: 'mcp' } })
    const wideLinks = wide.messages.filter((m) => m.content.type === 'resource_link')
    record(
      '5. prompts/get 的消息里含 resource_link，且按标签真的筛过',
      links.length === 1 && wideLinks.length > links.length,
      `transport 命中 ${links.length} 篇，mcp 命中 ${wideLinks.length} 篇`
    )

    // 6. 非法游标被拒绝（不是静默返回第一页）
    let rejected = false
    try {
      await client.listResources({ cursor: 'not-a-real-cursor' })
    } catch {
      rejected = true
    }
    record('6. 非法游标被拒绝而不是静默回第一页', rejected, rejected ? '已拒绝' : '居然成功了')
  } finally {
    await client.close()
    await server.close()
  }

  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name} —— ${c.detail}`)
  const failed = checks.filter((c) => !c.ok).length
  console.log(`\n${checks.length - failed}/${checks.length} 项通过`)
  process.exit(failed === 0 ? 0 : 1)
}

if (process.env.SELFTEST === '1') {
  await selftest()
} else {
  await serveStdio()
}
