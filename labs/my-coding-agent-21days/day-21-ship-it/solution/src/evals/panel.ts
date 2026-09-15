/**
 * 评估结果面板。本天新增，端口 3120。
 *
 * 它只有两条路由：`/` 给一张静态页，`/api/runs` 给 JSON。为什么要拆成两条而不是
 * 直接把数字拼进 HTML：**报告是数据，面板是数据的一种呈现。** 拆开之后，
 * 同一份 JSON 可以被 CI 取走做门禁（通过率低于某个线就让流水线红），
 * 也可以被下一次评估拿来做前后对比，而不必去解析一页 HTML。
 *
 * 零依赖：node:http 加一段手写的 HTML 字符串。不引任何前端框架，
 * 页面自己 fetch 一次那条 JSON 接口，这是这门课一贯的做法。
 */
import http from 'node:http'
import { listReportIds, loadReport } from './report.js'

export const PANEL_PORT = 3120

const PAGE = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
  '<title>mca 评估面板</title><style>',
  'body{font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;margin:2rem;max-width:52rem}',
  'table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}',
  'th,td{border:1px solid #ccc;padding:.35rem .6rem;text-align:left}',
  'th{background:#f5f5f5}.ok{color:#137333}.bad{color:#c5221f}',
  '.note{color:#666}h2{margin-top:2rem;font-size:1rem}',
  '</style></head><body><h1>mca 评估面板</h1>',
  '<p class="note">数据来自 work/evals 下最近一次评估；原始 JSON 在 <a href="/api/runs">/api/runs</a>。</p>',
  '<div id="app">加载中…</div><script>',
  'const pct = v => v === null ? "不可用" : (v * 100).toFixed(1) + "%";',
  'fetch("/api/runs").then(r => r.json()).then(data => {',
  '  const run = data.latest;',
  '  if (!run) { app.textContent = "还没有跑过评估，先在 REPL 里执行 /eval"; return; }',
  '  let html = "<p>" + run.runId + " · " + run.model + " · 每题跑 " + run.repeat + " 次</p>";',
  '  for (const v of run.variants) {',
  '    const s = v.summary;',
  '    html += "<h2>" + v.variantId + " — " + v.label + "</h2>";',
  '    html += "<table><tr><th>指标</th><th>值</th></tr>";',
  '    html += "<tr><td>通过率</td><td>" + pct(s.passRate) + " (" + s.passed + "/" + s.attempts + ")</td></tr>";',
  '    html += "<tr><td>平均轮数</td><td>" + s.avgRounds.toFixed(1) + "</td></tr>";',
  '    html += "<tr><td>token 合计</td><td>" + s.totalTokens + "（平均 " + Math.round(s.avgTotalTokens) + "）</td></tr>";',
  '    html += "<tr><td>缓存命中率</td><td>" + pct(s.cacheHitRate) + "</td></tr>";',
  '    html += "<tr><td>成本</td><td>" + (s.cost === null ? "未配单价" : s.cost.toFixed(6) + " " + run.rates.currency) + "</td></tr>";',
  '    html += "</table><p class=\'note\'>" + s.cacheNote + "</p>";',
  '    html += "<table><tr><th>题</th><th>难度</th><th>结果</th><th>轮数</th><th>token</th><th>工具</th><th>没过的判据</th></tr>";',
  '    for (const a of v.attempts) {',
  '      const bad = a.checks.filter(c => !c.ok).map(c => c.label).join("、");',
  '      html += "<tr><td>" + a.taskId + "</td><td>" + a.difficulty + "</td>";',
  '      html += "<td class=" + (a.passed ? "ok>通过" : "bad>没过") + "</td>";',
  '      html += "<td>" + a.rounds + "</td><td>" + a.totalTokens + "</td><td>" + a.toolCalls + "</td>";',
  '      html += "<td>" + (bad || "—") + "</td></tr>";',
  '    }',
  '    html += "</table>";',
  '  }',
  '  app.innerHTML = html;',
  '});',
  '</script></body></html>',
].join('\n')

export interface Panel {
  url: string
  close(): Promise<void>
}

export async function startPanel(port: number = PANEL_PORT): Promise<Panel> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/api/runs')) {
      void (async () => {
        const ids = await listReportIds()
        const latest = ids[0] ? await loadReport(ids[0]) : null
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ runs: ids, latest }))
      })()
      return
    }
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('只有两条路由：/ 与 /api/runs')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve())
  })

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        // closeAllConnections 不能省：keep-alive 的浏览器连接会让 close 一直不回调
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
