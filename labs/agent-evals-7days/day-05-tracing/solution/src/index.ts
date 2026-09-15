/**
 * evalkit CLI —— D5 版本：跑一个套件，落盘链路，打印成本延迟面板。
 *
 * 跑：
 *   MOCK=1 pnpm start                  # 默认 k=5
 *   MOCK=1 pnpm start -- --k 10
 *   MOCK=1 pnpm start -- --seed 42     # 固定种子，链路逐字可复现
 *   MOCK=1 pnpm start -- --sample 0.2  # 尾部采样：失败全留，成功留两成
 *
 * 落盘位置：work/traces.jsonl（一行一条 span，可以直接 grep 或喂给 jq）。
 * 起 pnpm collector 之后可以在 http://localhost:3145 里查。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runSuite } from './core/runner'
import { createTarget } from './agent/target'
import { day05Tasks } from './tasks/day05'
import { Tracer } from './otel/tracer'
import { Instrumentation } from './otel/instrument'
import { aggregate, tailSample } from './otel/aggregate'
import { SEMCONV_STABILITY, SEMCONV_VERSION } from './otel/semconv'

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function pad(text: string, width: number): string {
  // 中文按两格宽算，否则表格会歪
  const w = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return text + ' '.repeat(Math.max(0, width - w))
}

async function main(): Promise<void> {
  const k = arg('k', 5)
  const seed = arg('seed', 20260914)
  const sample = arg('sample', 1)

  const tracer = new Tracer({ idSeed: 1, now: () => 1_767_000_000_000 })
  const instrumentation = new Instrumentation(tracer, {
    providerName: 'openai-compatible-gateway',
    model: process.env.LLM_MODEL ?? 'mock-model',
    temperature: 0,
    maxTokens: 1024,
  })

  const target = instrumentation.wrap(createTarget(seed))

  console.log(`靶子：${target.name}`)
  console.log(`语义约定：${SEMCONV_VERSION}（${SEMCONV_STABILITY}）`)
  console.log(`任务数：${day05Tasks.length}　每个任务跑 ${k} 次　种子：${seed}\n`)

  const report = await runSuite(day05Tasks, target, k)

  // 评估结论回挂到链路。前四天的分数在这一步变成遥测数据。
  for (const t of report.tasks) {
    t.grades.forEach((grades, i) => instrumentation.attachEvaluation(t.taskId, i, grades))
  }

  const all = tracer.finished()
  const kept = sample >= 1 ? all : tailSample(all, sample)
  const panel = aggregate(kept)

  const out = resolve('work/traces.jsonl')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, kept.map((s) => JSON.stringify(s)).join('\n'), 'utf8')

  console.log('—— 成本与延迟面板（只从 span 聚合，不读 runner 的内存） ——')
  console.log(
    `${pad('任务', 26)}${pad('试次', 6)}${pad('失败率', 9)}${pad('花费(分)', 11)}${pad('p50(ms)', 10)}${pad('p95(ms)', 10)}工具调用`
  )
  for (const r of panel.rows) {
    console.log(
      `${pad(r.taskId, 26)}${pad(String(r.trials), 6)}${pad(pct(r.failureRate), 9)}${pad(r.costCents.toFixed(2), 11)}${pad(r.p50Ms.toFixed(0), 10)}${pad(r.p95Ms.toFixed(0), 10)}${r.toolCalls}`
    )
  }

  console.log('')
  console.log(`链路条数：${panel.traces}　总花费：${panel.totalCostCents.toFixed(2)} 分`)
  console.log(
    `首块延迟采集覆盖率：${panel.ttfcCoverage.withValue}/${panel.ttfcCoverage.total}　` +
      `均值：${panel.avgTtfcSeconds === null ? '未采集' : `${panel.avgTtfcSeconds.toFixed(2)} s`}`
  )
  if (sample < 1) {
    console.log(
      `采样：失败全留 + 成功留 ${pct(sample)}，${all.length} 条 span 留下 ${kept.length} 条`
    )
  }
  console.log(`链路已落盘：${out}`)
  console.log('')
  console.log('注意 ev-004 那一行：它的失败率和 ev-001 一样低，但工具调用次数明显更多。')
  console.log('只看 pass 率永远看不见这件事 —— 它花的是钱和时间，不是正确性。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
