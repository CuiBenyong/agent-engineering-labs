// SELFTEST 的编排：逐项打印结果并按结果设退出码。这是验收入口，不是教学重点。
// 先读 stdio-client.ts 与 registry.ts。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, resultText } from './protocol.js'
import { StdioClient } from './stdio-client.js'
import { ToolRegistry, isValidModelToolName, modelToolName, type ServerSpec } from './registry.js'
import { MockModel, runLoop } from './agent.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serversDir = path.resolve(here, '../../servers')

export function serverSpecs(
  extra: Partial<Record<'notes' | 'tickets', ServerSpec>> = {}
): ServerSpec[] {
  const notes: ServerSpec = {
    alias: 'notes',
    command: process.execPath,
    args: [path.join(serversDir, 'notes-server.mjs')],
    timeoutMs: 3000,
    ...(extra.notes ?? {}),
  }
  const tickets: ServerSpec = {
    alias: 'tickets',
    command: process.execPath,
    args: [path.join(serversDir, 'tickets-server.mjs')],
    timeoutMs: 3000,
    ...(extra.tickets ?? {}),
  }
  return [notes, tickets]
}

const results: { name: string; ok: boolean }[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${detail}`)
}

/** 练习没做完时某一项可能直接抛异常。抛了就算这一项没过，不能带着整份自测一起死。 */
async function guard(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    check(name, false, `抛异常了：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function runSelftest(): Promise<number> {
  console.log('\n=== D5 自测 ===\n')

  // 1. 发现：单个服务端能连上，并报出自己支持的协议版本
  await guard('server/discover 拿到支持的协议版本', async () => {
    const client = new StdioClient(serverSpecs()[0])
    client.start()
    let versions: unknown = null
    try {
      versions = (await client.request('server/discover')).supportedVersions
    } catch (error) {
      versions = error instanceof Error ? error.message : String(error)
    }
    const ok = Array.isArray(versions) && versions.includes(PROTOCOL_VERSION)
    check('server/discover 拿到支持的协议版本', ok, `supportedVersions=${JSON.stringify(versions)}`)
    client.close()
  })

  // 2. 协议错误必须立刻抛出。漏了 error 分支的客户端会一直等到超时才报错。
  await guard('协议错误被立刻抛出而不是等到超时', async () => {
    const client = new StdioClient({ ...serverSpecs()[0], timeoutMs: 2000 })
    client.start()
    const started = Date.now()
    let message = '（没有抛异常）'
    try {
      await client.request('tools/call', { name: 'nope', arguments: {} })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const elapsed = Date.now() - started
    check(
      '协议错误被立刻抛出而不是等到超时',
      message.includes('Unknown tool') && elapsed < 1000,
      `${elapsed}ms：${message}`
    )
    client.close()
  })

  const registry = new ToolRegistry()
  registry.connect(serverSpecs())
  await registry.refresh()
  const names = registry.toolNames()

  // 3. 分页翻完：notes 每页只回 2 个，一共 3 个
  await guard('tools/list 分页翻完（notes 应有 3 个工具）', async () => {
    const fromNotes = names.filter((n) => n.startsWith('mcp__notes__'))
    check(
      'tools/list 分页翻完（notes 应有 3 个工具）',
      fromNotes.length === 3,
      `拿到 ${fromNotes.length} 个：${fromNotes.join('、') || '（空）'}`
    )
  })

  // 4. 翻译出来的名字对模型 API 合法
  await guard('工具名对模型 API 合法', async () => {
    const bad = names.filter((n) => !isValidModelToolName(n))
    check(
      '工具名对模型 API 合法（64 字符内、只含字母数字下划线连字符）',
      bad.length === 0 && names.length > 0,
      `共 ${names.length} 个，非法 ${bad.length} 个`
    )
  })

  // 5. 重名消歧：两个服务端各有一个 search，聚合后必须都还在
  await guard('两个 search 被消歧且能反查回原名', async () => {
    const a = registry.lookup(modelToolName('notes', 'search'))
    const b = registry.lookup(modelToolName('tickets', 'search'))
    const ok =
      !!a && !!b && a.toolName === 'search' && b.toolName === 'search' && a.alias !== b.alias
    check(
      '两个 search 被消歧且能反查回原名',
      ok,
      `notes 侧 ${a?.toolName ?? '（查不到）'}，tickets 侧 ${b?.toolName ?? '（查不到）'}`
    )
  })

  // 6. 正常调用
  await guard('调用 notes 的 search 拿到结果', async () => {
    const result = await registry.call(modelToolName('notes', 'search'), { query: '分页' })
    const text = resultText(result)
    check(
      '调用 notes 的 search 拿到结果',
      result.isError !== true && text.includes('pagination'),
      text.replace(/\n/g, ' / ').slice(0, 60)
    )
  })

  // 7. 工具执行错误不能变成异常
  await guard('工具执行错误作为 isError 结果返回给模型', async () => {
    const result = await registry.call(modelToolName('tickets', 'close_ticket'), { id: 'T-9999' })
    const text = resultText(result)
    check(
      '工具执行错误作为 isError 结果返回给模型',
      result.isError === true && text.includes('T-100'),
      text.slice(0, 60)
    )
  })

  // 8. 失败隔离：让 tickets 慢到必然超时，notes 必须照常可用
  await guard('单个服务端超时被降级，其余工具照常可用', async () => {
    const slow = new ToolRegistry()
    slow.connect(
      serverSpecs({
        tickets: {
          alias: 'tickets',
          command: process.execPath,
          args: [path.join(serversDir, 'tickets-server.mjs')],
          env: { SLOW_MS: '4000' },
          timeoutMs: 600,
        },
      })
    )
    await slow.refresh()
    const survived = slow.toolNames().filter((n) => n.startsWith('mcp__notes__')).length
    const fallback = await slow.call(modelToolName('tickets', 'search'), { query: 'open' })
    const ok = slow.down.has('tickets') && survived === 3 && fallback.isError === true
    check(
      '单个服务端超时被降级，其余工具照常可用',
      ok,
      `down=${[...slow.down.keys()].join('、') || '（空）'}，notes 还剩 ${survived} 个工具`
    )
    slow.closeAll()
  })

  // 9. 离线 Agent 循环跑通
  await guard('离线 Agent 循环选中带前缀的工具并拿到答案', async () => {
    const loop = await runLoop(new MockModel(), registry, '帮我在笔记里搜一下分页是怎么讲的')
    const ok =
      loop.used.length === 1 &&
      loop.used[0].startsWith('mcp__notes__') &&
      loop.answer.includes('pagination')
    check(
      '离线 Agent 循环选中带前缀的工具并拿到答案',
      ok,
      `用了 ${loop.used.join('、') || '（没调工具）'}，${loop.steps} 步`
    )
  })

  registry.closeAll()

  const failed = results.filter((r) => !r.ok).length
  console.log(
    `\n共 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项。\n`
  )
  return failed === 0 ? 0 : 1
}
