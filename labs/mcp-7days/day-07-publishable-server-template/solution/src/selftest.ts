// SELFTEST 的编排：逐项打印结果并按结果设退出码。先读 eval.ts 与 publish-check.ts。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, type JsonValue } from './protocol.js'
import { handle, TOOLS } from './server.js'
import { metrics } from './metrics.js'
import { loadCases, runEval, summarize } from './eval.js'
import { AlwaysSearchSelector, RuleSelector } from './selector.js'
import { checkPublish, type PackageJson, type ServerJson } from './publish-check.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const results: { name: string; ok: boolean }[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name} —— ${detail}`)
}

async function guard(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    check(name, false, `抛异常了：${error instanceof Error ? error.message : String(error)}`)
  }
}

function call(method: string, params: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return handle({
    id: 1,
    method,
    params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION } },
  })
}

export async function runSelftest(): Promise<number> {
  console.log('\n=== D7 自测 ===\n')

  // 1. 服务端本体
  await guard('tools/list 返回 3 个工具且都有描述', async () => {
    const result = call('tools/list').result as Record<string, JsonValue>
    const tools = result.tools as unknown as { name: string; description: string }[]
    const ok = tools.length === 3 && tools.every((t) => t.description.length > 10)
    check(
      'tools/list 返回 3 个工具且都有描述',
      ok,
      `${tools.length} 个：${tools.map((t) => t.name).join('、')}`
    )
  })

  const cases = loadCases()

  // 2. 评估集三类齐全
  await guard('评估集加载正常且三类齐全', async () => {
    const kinds = new Set(cases.map((c) => c.kind))
    const ok = cases.length >= 9 && kinds.size === 3
    check('评估集加载正常且三类齐全', ok, `${cases.length} 条，类别：${[...kinds].join('、')}`)
  })

  const runs = await runEval(new RuleSelector(), TOOLS, cases)
  const summary = summarize(runs)

  // 3. 正例
  await guard('正例全部选中该选的工具', async () => {
    const ok = summary.happy.total > 0 && summary.happy.pass === summary.happy.total
    const bad = runs.filter((r) => r.kind === 'happy' && !r.pass).map((r) => r.id)
    check(
      '正例全部选中该选的工具',
      ok,
      `${summary.happy.pass}/${summary.happy.total}${bad.length ? `，挂的是 ${bad.join('、')}` : ''}`
    )
  })

  // 4. 边界
  await guard('边界用例全部选对', async () => {
    const ok = summary.edge.total > 0 && summary.edge.pass === summary.edge.total
    const bad = runs
      .filter((r) => r.kind === 'edge' && !r.pass)
      .map((r) => `${r.id} 选了 ${String(r.actual)}`)
    check(
      '边界用例全部选对',
      ok,
      `${summary.edge.pass}/${summary.edge.total}${bad.length ? `，挂的是 ${bad.join('；')}` : ''}`
    )
  })

  // 5. 诱导误选：正常选择器要全过，故意选错的选择器要全挂——后半句才是在验断言本身
  await guard('诱导误选的负例被判为不该调用', async () => {
    const evil = summarize(await runEval(new AlwaysSearchSelector(), TOOLS, cases))
    const ok =
      summary.trap.pass === summary.trap.total && summary.trap.total > 0 && evil.trap.pass === 0
    check(
      '诱导误选的负例被判为不该调用',
      ok,
      `规则选择器 ${summary.trap.pass}/${summary.trap.total}，故意选错的选择器 ${evil.trap.pass}/${evil.trap.total}（应为 0）`
    )
  })

  // 6. 指标
  await guard('调用计时与错误计数被记录', async () => {
    metrics.reset()
    call('tools/call', { name: 'search_docs', arguments: { query: '分页' } })
    call('tools/call', { name: 'search_docs', arguments: { query: '发布' } })
    call('tools/call', { name: 'get_doc', arguments: { slug: 'pagination' } })
    call('tools/call', { name: 'get_doc', arguments: { slug: '不存在的' } }) // 工具执行错误
    call('tools/call', { name: 'no_such_tool', arguments: {} }) // 协议错误
    const stats = metrics.snapshot()
    const search = stats.find((s) => s.tool === 'search_docs')
    const ok =
      metrics.total === 5 &&
      metrics.errors === 2 &&
      !!search &&
      search.calls === 2 &&
      search.p95 >= 0
    check(
      '调用计时与错误计数被记录',
      ok,
      `共 ${metrics.total} 次，错误 ${metrics.errors} 次，search_docs 的 P95 是 ${search?.p95 ?? '（没有）'}ms`
    )
  })

  // 7. 发布检查
  await guard('发布检查能挡住不一致的元数据', async () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJson
    const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8')) as ServerJson
    const clean = checkPublish(pkg, server)
    const dirty = checkPublish({ ...pkg, mcpName: 'io.github.someone-else/docs' }, server)
    const ok = clean.length === 0 && dirty.some((p) => p.includes('mcpName'))
    check(
      '发布检查能挡住不一致的元数据',
      ok,
      `当前配置 ${clean.length} 个问题${clean.length ? `（${clean[0]}）` : ''}；改坏 mcpName 后 ${dirty.length} 个问题`
    )
  })

  const failed = results.filter((r) => !r.ok).length
  console.log(
    `\n共 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项。\n`
  )
  return failed === 0 ? 0 : 1
}
