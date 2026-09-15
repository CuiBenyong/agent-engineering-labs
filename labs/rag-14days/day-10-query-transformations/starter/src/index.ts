import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChunks } from './corpus'
import { loadGoldenSet } from './goldenset'
import { aggregate, packContext, traceOf, type RetrievalMetrics } from './metrics'
import { BASELINE, runQuery, withOnly, type PipelineConfig } from './pipeline'
import { createWeek1Retriever } from './retrieve'
import { resetModelCalls, totalModelCalls, type Turn } from './transforms'

/**
 * 一条命令跑完全部对照：
 *
 *   MOCK=1 pnpm start   离线：哈希向量 + 五种手法的确定性规则替身，不需要任何 key
 *   pnpm start          真实：OpenAI 向量 + Anthropic 改写 / 假设文档 / 多路 / 后退 / 意图分类
 *
 * 输出四块：逐项开关的指标与成本对照、多轮对话的指代消解、默认配置、验收清单。
 * starter 原样跑会有几项 ❌，做完练习全部变 ✅。
 */

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports')

/** 每次模型调用的估算耗时。**占位值**，不是实测——MOCK 下模型压根不走网络 */
const LATENCY_PER_CALL_MS = Number(process.env.LATENCY_PER_CALL_MS ?? 900)

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const width = (s: string): number =>
  [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)

function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => width(r[i]))))
  for (const row of rows) {
    console.log(row.map((cell, i) => cell + ' '.repeat(widths[i] - width(cell))).join('  '))
  }
}

interface RunResult {
  name: string
  cfg: PipelineConfig
  metrics: RetrievalMetrics
  modelCalls: number
  retrievals: number
}

async function main(): Promise<void> {
  const chunks = loadChunks()
  const questions = loadGoldenSet()
  const retriever = await createWeek1Retriever(chunks)

  console.log(
    `\n语料 30 篇 / ${chunks.length} 块｜题集 ${questions.length} 题｜向量后端 ${retriever.backendName}`
  )
  console.log('检索器逐字沿用第八天，本天只动「查询进来之后、检索发生之前」那一段。\n')

  const configs: Array<[string, PipelineConfig]> = [
    ['基线（什么都不开）', BASELINE],
    ['+ 查询改写', withOnly('rewrite')],
    ['+ 假设文档嵌入', withOnly('hyde')],
    ['+ 多路查询', withOnly('multiQuery')],
    ['+ 后退提问', withOnly('stepBack')],
    ['+ 意图路由（同一预算）', withOnly('router')],
    ['+ 意图路由（多跳加预算）', { ...withOnly('router'), budgetByIntent: true }],
    [
      '默认配置（改写 + 路由 + 分预算）',
      { ...BASELINE, rewrite: true, router: true, budgetByIntent: true },
    ],
    [
      '全开',
      {
        rewrite: true,
        hyde: true,
        multiQuery: true,
        stepBack: true,
        router: true,
        budgetByIntent: true,
      },
    ],
  ]

  const runs: RunResult[] = []
  for (const [name, cfg] of configs) {
    resetModelCalls()
    let retrievals = 0
    const traces = []
    for (const q of questions) {
      const res = await runQuery(retriever, q.question, [], cfg)
      retrievals += res.retrievals
      traces.push(traceOf(q, res.candidates, chunks, res.budget))
    }
    runs.push({ name, cfg, metrics: aggregate(traces), modelCalls: totalModelCalls(), retrievals })
  }

  const base = runs[0]
  const delta = (cur: number, ref: number): string => {
    const d = (cur - ref) * 100
    return d === 0 ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`
  }

  console.log('一、逐项开关（20 题，指标口径与第八天完全一致）')
  printTable([
    [
      '配置',
      '召回率',
      'Δ',
      'multi',
      'MRR',
      'nDCG',
      '拒答率',
      '上下文',
      '模型调用',
      '检索次数',
      '估算延迟',
    ],
    ...runs.map((r) => [
      r.name,
      pct(r.metrics.recall),
      delta(r.metrics.recall, base.metrics.recall),
      pct(r.metrics.recallMulti),
      r.metrics.mrr.toFixed(3),
      r.metrics.ndcg.toFixed(3),
      pct(r.metrics.abstainRate),
      String(r.metrics.avgContextTokens),
      String(r.modelCalls),
      String(r.retrievals),
      `+${(((r.modelCalls - base.modelCalls) / questions.length) * LATENCY_PER_CALL_MS).toFixed(0)}ms`,
    ]),
  ])
  console.log(
    `\n   「估算延迟」= 每题多出来的模型调用次数 × ${LATENCY_PER_CALL_MS}ms（占位值，可用 LATENCY_PER_CALL_MS 覆盖）。`
  )
  console.log(
    '   MOCK=1 下模型不走网络，这一列是算出来的，不是测出来的；token 与调用次数才是实的。'
  )
  console.log(
    '   MRR 这一列会一直是 1.0000：题目从语料反向出、字面重合度高，第一名永远是答案文档。'
  )
  console.log(
    '   这是指标饱和，不是系统满分——单文档召回率同样已经 100%。今天的证据只看 multi 召回率、nDCG 和拒答率。'
  )

  // -------------------------------------------------------------------------
  // 二、多轮对话：不消解指代，检索必然跑偏
  // -------------------------------------------------------------------------
  console.log('\n二、多轮对话（同一段对话跑两遍：不改写 / 改写）')

  const dialogue = [
    '生产数据库主备切换必须由谁书面审批？',
    '这个人叫什么名字？',
    '谢谢，你还能帮我查什么？',
  ]

  const rows: string[][] = [['轮次', '模式', '实际检索式', '意图', '进入上下文的文档', '检索次数']]
  for (const rewrite of [false, true]) {
    const history: Turn[] = []
    for (const [i, turn] of dialogue.entries()) {
      const cfg: PipelineConfig = { ...BASELINE, rewrite, router: true, budgetByIntent: true }
      const res = await runQuery(retriever, turn, history, cfg)
      const packed = packContext(
        res.candidates.filter((c) => c.admitted),
        res.budget
      )
      rows.push([
        `第 ${i + 1} 轮`,
        rewrite ? '改写' : '不改写',
        res.queries[0] ?? '（不检索）',
        res.intent ?? '-',
        res.intent === 'direct'
          ? '（不检索，直接回答）'
          : packed.docIds.join(' ') || '（一条都没过门槛，只能拒答）',
        String(res.retrievals),
      ])
      history.push({ role: 'user', content: turn })
      history.push({
        role: 'assistant',
        content: res.candidates
          .slice(0, 2)
          .map((c) => c.chunk.text)
          .join('\n'),
      })
    }
  }
  printTable(rows)
  const turn2 = (mode: string): string =>
    rows.find((r) => r[0] === '第 2 轮' && r[1] === mode)?.[4] ?? ''
  const resolvedHitsDoc014 = turn2('改写').includes('doc-014')
  console.log(
    '\n   第 2 轮的「这个人」指的是 doc-019 里那个只留了角色名的「平台组组长」，而「周敏」这个名字只写在 doc-014。'
  )
  console.log(`   不改写：${turn2('不改写')}`)
  console.log(`   改写后：${turn2('改写')}`)
  console.log(
    '   注意路由的顺序：不改写时「这个人」触发了多跳信号词、白跑一轮；改写之后它是个普通单跳问题——先改写，再路由。'
  )
  const chitchatRetrievals = rows.find((r) => r[0] === '第 3 轮')?.[5] ?? '?'
  console.log(
    `   第 3 轮是闲聊，路由把它判成 direct 就一次检索都不用发；本次实际发了 ${chitchatRetrievals} 次——这就是分流省下来的钱。`
  )

  // -------------------------------------------------------------------------
  // 三、默认配置
  // -------------------------------------------------------------------------
  const def = runs.find((r) => r.name.startsWith('默认配置'))
  const all = runs.find((r) => r.name === '全开')
  console.log('\n三、默认配置：只开「查询改写 + 意图路由（多跳加预算）」')
  console.log(
    `   默认配置召回率 ${pct(def?.metrics.recall ?? 0)}，全开 ${pct(all?.metrics.recall ?? 0)}，基线 ${pct(base.metrics.recall)}。`
  )
  console.log('   关掉假设文档嵌入、多路查询、后退提问的理由见 README「默认配置的取舍」一节。')

  // -------------------------------------------------------------------------
  // 四、验收
  // -------------------------------------------------------------------------
  const hyde = runs.find((r) => r.cfg.hyde && !r.cfg.rewrite)
  const mq = runs.find((r) => r.cfg.multiQuery && !r.cfg.rewrite)
  const router = runs.find((r) => r.cfg.router && r.cfg.budgetByIntent && !r.cfg.rewrite)

  const checks: Array<[string, boolean]> = [
    [
      '五种手法都真的跑起来了（每种至少发生一次模型调用）',
      runs.slice(1, 7).every((r) => r.modelCalls > 0),
    ],
    ['多路查询真的发了多于一次检索（20 题应远超 20 次）', (mq?.retrievals ?? 0) > questions.length],
    [
      '假设文档嵌入改变了检索结果（指标或上下文 token 与基线不同）',
      hyde !== undefined &&
        (hyde.metrics.recall !== base.metrics.recall ||
          hyde.metrics.mrr !== base.metrics.mrr ||
          hyde.metrics.avgContextTokens !== base.metrics.avgContextTokens),
    ],
    [
      '意图路由认出了多跳题：多跳召回率高于基线，且单跳召回率没掉',
      (router?.metrics.recallMulti ?? 0) > base.metrics.recallMulti &&
        (router?.metrics.recallSingle ?? 0) >= base.metrics.recallSingle,
    ],
    ['多轮对话里，指代消解后 doc-014（写着「周敏」的那篇）进了上下文', resolvedHitsDoc014],
    [
      '不消解指代时，第 2 轮一条候选都过不了门槛（只能拒答）',
      turn2('不改写') !== turn2('改写') && !turn2('不改写').includes('doc-'),
    ],
    ['闲聊那一轮的检索次数是 0', rows.some((r) => r[0] === '第 3 轮' && r[5] === '0')],
    [
      '默认配置的召回率不低于基线，且模型调用少于全开',
      (def?.metrics.recall ?? 0) >= base.metrics.recall &&
        (def?.modelCalls ?? 0) < (all?.modelCalls ?? 0),
    ],
  ]
  console.log('\n四、验收')
  for (const [name, ok] of checks) console.log(`   ${ok ? '✅' : '❌'} ${name}`)

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, 'latest.json')
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        generatedBy: 'rag-14days / day-10',
        mock: process.env.MOCK === '1',
        embedBackend: retriever.backendName,
        chunks: chunks.length,
        questions: questions.length,
        latencyPerCallMsPlaceholder: LATENCY_PER_CALL_MS,
        runs: runs.map((r) => ({
          name: r.name,
          config: r.cfg,
          metrics: r.metrics,
          modelCalls: r.modelCalls,
          retrievals: r.retrievals,
        })),
      },
      null,
      2
    )}\n`
  )
  console.log(`\n报告已写入：${out}`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
