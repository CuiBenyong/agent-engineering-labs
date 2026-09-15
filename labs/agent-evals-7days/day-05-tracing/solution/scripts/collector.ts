/**
 * 一个玩具收集端：把落盘的链路查出来。**只用 node:http，零依赖。**
 *
 * 跑：
 *   MOCK=1 pnpm start          # 先产出 work/traces.jsonl
 *   pnpm collector             # 另开一个终端
 *   curl http://localhost:3145/panel
 *   curl 'http://localhost:3145/trace?id=t0000...'
 *
 * 真实环境里这一端是 OpenTelemetry Collector 或某个后端服务，
 * 它做的事情比这里多得多（批处理、重试、限流、脱敏、多租户）。
 * 这里只保留最本质的一件：**span 是可以按 traceId 查回来的一棵树**。
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { aggregate } from '../src/otel/aggregate'
import { durationMs, groupByTrace, type Span } from '../src/otel/tracer'

const PORT = 3145
const FILE = resolve('work/traces.jsonl')

function load(): Span[] {
  try {
    return readFileSync(FILE, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Span)
  } catch {
    return []
  }
}

function renderTree(spans: Span[]): string {
  const children = new Map<string, Span[]>()
  const roots: Span[] = []
  for (const s of spans) {
    if (!s.parentSpanId) roots.push(s)
    else {
      const list = children.get(s.parentSpanId)
      if (list) list.push(s)
      else children.set(s.parentSpanId, [s])
    }
  }
  const lines: string[] = []
  const walk = (s: Span, depth: number): void => {
    lines.push(
      `${'  '.repeat(depth)}${s.status === 'error' ? '✗' : '·'} ${s.name}  ${durationMs(s).toFixed(0)}ms`
    )
    for (const c of children.get(s.spanId) ?? []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return lines.join('\n')
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const spans = load()
  res.setHeader('content-type', 'text/plain; charset=utf-8')

  if (url.pathname === '/panel') {
    res.end(JSON.stringify(aggregate(spans), null, 2))
    return
  }
  if (url.pathname === '/trace') {
    const id = url.searchParams.get('id') ?? ''
    const group = groupByTrace(spans).get(id)
    res.end(group ? renderTree(group) : `没有这条链路：${id}`)
    return
  }
  const ids = [...groupByTrace(spans).keys()]
  res.end(
    [
      `span 总数：${spans.length}　链路数：${ids.length}`,
      '',
      'GET /panel            成本与延迟面板',
      'GET /trace?id=<traceId>  单条链路的树',
      '',
      ...ids.slice(0, 20).map((id) => `  ${id}`),
    ].join('\n')
  )
})
  .on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用 —— 多半是上一次的收集端还没退。`)
      console.error(`  lsof -ti:${PORT} | xargs kill`)
      process.exit(1)
    }
    throw e
  })
  .listen(PORT, () => {
    console.log(`收集端已启动：http://localhost:${PORT}`)
    console.log(`数据源：${FILE}（先跑 MOCK=1 pnpm start 产出它）`)
  })
