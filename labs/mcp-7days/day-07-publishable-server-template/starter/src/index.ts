// 入口。三种跑法：
//   pnpm start            起 stdio 服务端（真正被客户端加载时走这条）
//   SELFTEST=1 pnpm start 跑 7 项自测后退出
//   EVAL=1 pnpm start     只跑评估集并打印跑分表
import 'dotenv/config'
import readline from 'node:readline'
import http from 'node:http'
import { handle, TOOLS } from './server.js'
import { metrics } from './metrics.js'
import { loadCases, runEval, summarize } from './eval.js'
import { ModelSelector, RuleSelector, type Selector } from './selector.js'
import { runSelftest } from './selftest.js'

if (process.env.SELFTEST === '1') {
  process.exit(await runSelftest())
}

if (process.env.EVAL === '1') {
  const key = process.env.OPENROUTER_API_KEY ?? ''
  const useModel = process.env.MOCK !== '1' && key !== ''
  const selector: Selector = useModel
    ? new ModelSelector(key, process.env.MODEL ?? 'openai/gpt-4o-mini')
    : new RuleSelector()
  console.log(`选择器：${useModel ? '真模型' : '离线规则'}\n`)
  const cases = loadCases()
  const results = await runEval(selector, TOOLS, cases)
  for (const r of results) {
    console.log(
      `${r.pass ? '✅' : '❌'} [${r.kind}] ${r.id}：期待 ${r.expected ?? '不调用'}，实际 ${r.actual ?? '不调用'}`
    )
  }
  const summary = summarize(results)
  console.log(
    `\n正例 ${summary.happy.pass}/${summary.happy.total}，` +
      `边界 ${summary.edge.pass}/${summary.edge.total}，` +
      `诱导误选 ${summary.trap.pass}/${summary.trap.total}`
  )
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}

// 指标端点。它和 MCP 端点是两回事：MCP 走 stdio，指标走 HTTP，互不干扰
const metricsPort = Number(process.env.METRICS_PORT ?? 0)
if (metricsPort > 0) {
  http
    .createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          { total: metrics.total, errors: metrics.errors, tools: metrics.snapshot() },
          null,
          2
        )
      )
    })
    .listen(metricsPort, '127.0.0.1', () => {
      // 日志只能走 stderr：stdout 上多一个字，客户端的 JSON 解析就炸
      console.error(`指标端点：http://127.0.0.1:${metricsPort}`)
    })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  try {
    const msg = JSON.parse(line)
    if (msg.id === undefined) return // 通知不回
    process.stdout.write(JSON.stringify(handle(msg)) + '\n')
  } catch {
    console.error(`无法解析的一行：${line.slice(0, 120)}`)
  }
})
rl.on('close', () => process.exit(0))
