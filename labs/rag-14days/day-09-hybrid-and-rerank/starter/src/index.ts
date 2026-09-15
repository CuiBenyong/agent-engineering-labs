import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChunks } from './corpus'
import { coverage, loadGoldenSet } from './goldenset'
import { FUSE_KEEP, PER_ROUTE_K, RRF_K, sweepRrfK } from './fuse'
import { createRoutes, RETRIEVAL } from './retrieve'
import { createRerankBackend } from './rerank'
import {
  blindSpots,
  CANDIDATE_K,
  CONFIGS,
  CONTEXT_BUDGET,
  LATENCY_MODEL,
  NDCG_K,
  PRICES,
  runConfig,
  type ConfigResult,
} from './evaluate'

/**
 * 一条命令跑完四档配置的对照：
 *
 *   MOCK=1 pnpm start   离线：哈希向量 + 确定性重排替身，不需要任何 key
 *   pnpm start          真实：OpenAI 向量 + Cohere rerank-v3.5（或 RERANK_BASE_URL 指向自部署）
 *
 * 最后一段的验收清单是 starter 的进度条：原样跑有 4 项是 ❌，做完 4 个练习全部变 ✅。
 */

const REPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports')
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const width = (s: string): number =>
  [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)

function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => width(r[i]))))
  for (const row of rows) {
    console.log(row.map((cell, i) => cell + ' '.repeat(widths[i] - width(cell))).join('  '))
  }
}

const delta = (cur: number, base: number, digits = 4): string => {
  const d = cur - base
  return `${d >= 0 ? '+' : ''}${d.toFixed(digits)}`
}

async function main(): Promise<void> {
  const chunks = loadChunks()
  const questions = loadGoldenSet()
  const routes = await createRoutes(chunks)
  const reranker = createRerankBackend()

  console.log(`\n语料 30 篇 / ${chunks.length} 块（块级检索，D1 是文档级，绝对分数不可直接比）`)
  const cov = coverage(questions)
  console.log(
    `题集 ${questions.length} 题：single ${cov.single}、multi ${cov.multi}、none ${cov.none}（来自 D8，一个字不改）`
  )
  console.log(
    `每路取前 ${PER_ROUTE_K}，融合后留前 ${FUSE_KEEP}，RRF k=${RRF_K}，上下文预算 ${CONTEXT_BUDGET} token，nDCG@${NDCG_K}`
  )
  console.log(`向量后端 ${routes.backendName}｜重排后端 ${reranker.name}`)

  const results: ConfigResult[] = []
  for (const config of CONFIGS) {
    results.push(await runConfig(config, routes, reranker, questions, chunks))
  }
  const [vec, bm25, hybrid, reranked] = results
  const baseline = vec.metrics

  console.log('\n一、指标账（四档配置，同一把尺子）')
  printTable([
    ['配置', '召回率', 'single', 'multi', 'MRR', `nDCG@${NDCG_K}`, '拒答率', '上下文token'],
    ...results.map((r) => [
      r.name,
      pct(r.metrics.recall),
      pct(r.metrics.recallSingle),
      pct(r.metrics.recallMulti),
      r.metrics.mrr.toFixed(4),
      r.metrics.ndcg.toFixed(4),
      pct(r.metrics.abstainRate),
      String(r.metrics.avgContextTokens),
    ]),
  ])
  console.log('   相对纯向量那一档的增量：')
  printTable([
    ['配置', '召回率', 'multi', `nDCG@${NDCG_K}`],
    ...results
      .slice(1)
      .map((r) => [
        r.name,
        delta(r.metrics.recall, baseline.recall),
        delta(r.metrics.recallMulti, baseline.recallMulti),
        delta(r.metrics.ndcg, baseline.ndcg),
      ]),
  ])

  console.log('\n二、延迟账')
  console.log(
    `   实测是 MOCK 下的纯本地计算，不含任何网络往返；建模那一列用的是占位值（LAT_EMBED_MS=${LATENCY_MODEL.embedMs}、LAT_RERANK_MS=${LATENCY_MODEL.rerankMs}），可用环境变量覆盖。`
  )
  printTable([
    ['配置', '实测 ms/问', '建模网络 ms/问', '建模合计 ms/问'],
    ...results.map((r) => [
      r.name,
      r.measuredMsPerQuestion.toFixed(2),
      r.modeledNetworkMsPerQuestion.toFixed(1),
      (r.measuredMsPerQuestion + r.modeledNetworkMsPerQuestion).toFixed(1),
    ]),
  ])

  console.log('\n三、成本账')
  console.log(
    `   单价是占位值（PRICE_EMBED_PER_MTOK=${PRICES.embedPerMTok}、PRICE_RERANK_PER_KSEARCH=${PRICES.rerankPerKSearch}），真正由实测撑着的是 token 数与调用次数这两列。`
  )
  printTable([
    ['配置', 'embed token/问', '重排调用/问', '重排输入 token/问', '每千问费用（占位）'],
    ...results.map((r) => [
      r.name,
      r.embedTokensPerQuestion.toFixed(1),
      r.rerankCallsPerQuestion.toFixed(2),
      r.rerankInputTokensPerQuestion.toFixed(1),
      r.costPerKQueries.toFixed(4),
    ]),
  ])

  console.log('\n四、两路的盲区（哪些题只有一路能命中）')
  const spots = blindSpots(bm25, vec)
  const text = (id: string): string => questions.find((q) => q.id === id)?.question ?? ''
  console.log(
    `   只有关键词一路命中：${spots.onlyBm25.length ? spots.onlyBm25.join('、') : '（无）'}`
  )
  for (const id of spots.onlyBm25) console.log(`      ${id} ${text(id)}`)
  console.log(
    `   只有向量一路命中：${spots.onlyVector.length ? spots.onlyVector.join('、') : '（无）'}`
  )
  for (const id of spots.onlyVector) console.log(`      ${id} ${text(id)}`)
  console.log(`   两路都没命中：${spots.neither.length ? spots.neither.join('、') : '（无）'}`)
  if (process.env.MOCK === '1') {
    console.log('   ⚠️  MOCK 下哈希向量保留字面重合度，向量一路的行为接近关键词检索，')
    console.log(
      '       所以这里几乎看不到「只有向量能命中」的题。这是 mock 的边界，不是混合检索没用。'
    )
  }

  console.log(`\n五、调一次 k 看排序变化（拿 ${questions[5].id} 这一问做样本）`)
  const sample = questions[5]
  const [kw, vv] = await Promise.all([
    Promise.resolve(routes.bm25(sample.question, PER_ROUTE_K)),
    routes.vector(sample.question, PER_ROUTE_K),
  ])
  const rankings = [kw.map((h) => h.chunkId), vv.map((h) => h.chunkId)]
  printTable([
    ['k', '融合后前 5 名', '与 k=60 相比变了几位'],
    ...sweepRrfK(rankings, [0, 1, 10, 60, 600], 5).map((row) => [
      String(row.k),
      row.top.join(' '),
      String(row.changedVsBase),
    ]),
  ])
  console.log('   k 越小越像「谁在自己那一路排第一谁就赢」，k 越大越奖励「两路都排进前列」。')

  console.log('\n六、每路取多少条（召回深度的敏感性，只跑混合那一档）')
  console.log(
    `   本语料只有 ${chunks.length} 块，每路取 ${PER_ROUTE_K} 条等于把 ${((PER_ROUTE_K / chunks.length) * 100).toFixed(0)}% 的库灌进融合。取深了不是更保险，是把噪声也一起投了票。`
  )
  const depths = [5, 10, 20, 50]
  const depthRows: string[][] = []
  for (const k of depths) {
    const r = await runConfig('hybrid', routes, reranker, questions, chunks, k)
    depthRows.push([
      String(k),
      pct(r.metrics.recall),
      pct(r.metrics.recallMulti),
      r.metrics.ndcg.toFixed(4),
      pct(r.metrics.abstainRate),
    ])
  }
  printTable([['每路取', '召回率', 'multi', `nDCG@${NDCG_K}`, '拒答率'], ...depthRows])

  console.log('\n七、重排改写了多少名次（混合 → 混合+重排，前 10 名逐位比）')
  let moved = 0
  for (const t of reranked.traces) {
    const before = hybrid.traces.find((h) => h.id === t.id)
    if (!before) continue
    moved += t.rankedDocIds.slice(0, 10).filter((d, i) => d !== before.rankedDocIds[i]).length
  }
  console.log(`   ${questions.length} 题的前 10 名里共有 ${moved} 个位置被重排改写。`)

  mkdirSync(REPORT_DIR, { recursive: true })
  const reportPath = join(REPORT_DIR, 'latest.json')
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: {
          corpusDocs: 30,
          chunks: chunks.length,
          perRouteTopK: PER_ROUTE_K,
          fuseKeep: FUSE_KEEP,
          rrfK: RRF_K,
          candidateK: CANDIDATE_K,
          contextBudget: CONTEXT_BUDGET,
          ndcgK: NDCG_K,
          gates: RETRIEVAL.gates,
          embedBackend: routes.backendName,
          rerankBackend: reranker.name,
          prices: PRICES,
          latencyModel: LATENCY_MODEL,
        },
        blindSpots: spots,
        configs: results.map((r) => ({
          name: r.name,
          metrics: r.metrics,
          measuredMsPerQuestion: r.measuredMsPerQuestion,
          modeledNetworkMsPerQuestion: r.modeledNetworkMsPerQuestion,
          embedTokensPerQuestion: r.embedTokensPerQuestion,
          rerankCallsPerQuestion: r.rerankCallsPerQuestion,
          rerankInputTokensPerQuestion: r.rerankInputTokensPerQuestion,
          costPerKQueries: r.costPerKQueries,
          perQuestion: r.traces.map((t) => ({
            id: t.id,
            type: t.type,
            hit: t.hit,
            reciprocalRank: Number(t.reciprocalRank.toFixed(4)),
            ndcg: Number(t.ndcg.toFixed(4)),
            contextDocIds: t.contextDocIds,
            contextTokens: t.contextTokens,
            admitted: t.admitted,
          })),
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  console.log(`\n报告已写入：${reportPath}`)

  const sweep = sweepRrfK(rankings, [0, 1, 10, RRF_K, 600], 5)
  const fusedDiffersFromBm25 = hybrid.traces.some((h) => {
    const b = bm25.traces.find((x) => x.id === h.id)
    return b ? h.rankedDocIds.join() !== b.rankedDocIds.join() : false
  })
  const checks: Array<[string, boolean]> = [
    ['融合真的发生了：混合那一档的排序与纯 BM25 那一档不同', fusedDiffersFromBm25],
    [
      `k 的扫描表跑出来了，且 k=0 与 k=${RRF_K} 的前 5 名不完全相同`,
      sweep.length === 5 && sweep[0].top.join() !== sweep[3].top.join(),
    ],
    ['重排真的改写了名次（20 题的前 10 名里至少有 1 个位置变了）', moved > 0],
    [
      '成本账算出来了：重排那一档的每千问费用高于不重排那一档',
      reranked.costPerKQueries > hybrid.costPerKQueries,
    ],
  ]
  console.log('\n八、验收')
  for (const [name, ok] of checks) console.log(`   ${ok ? '✅' : '❌'} ${name}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
