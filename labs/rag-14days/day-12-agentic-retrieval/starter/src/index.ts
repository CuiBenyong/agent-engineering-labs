import 'dotenv/config'
import { loadChunks } from './corpus'
import { loadGoldenSet } from './goldenset'
import { buildStats, createModelAssessor, createRuleAssessor, type Assessor } from './reflect'
import { createRetriever } from './retrieve'
import { BRAKES, SEARCH_TOOL, runAgenticRetrieval, runFixedRetrieval } from './agent'
import { compare } from './compare'

/**
 * 一条命令跑完今天的全部演示：
 *
 *   MOCK=1 pnpm start     离线：哈希向量 + 规则自评替身，不需要任何 key
 *   pnpm start            真实：OpenAI 向量 + claude-haiku-4-5-20251001 自评
 *
 * 最后一段「验收」是 starter 的进度条：原样跑有几项是 ❌，做完练习全部变 ✅。
 */

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const width = (s: string): number =>
  [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)

function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => width(r[i]))))
  for (const row of rows) {
    console.log(
      row.map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i] - width(cell)))).join('  ')
    )
  }
}

/** 多跳主线：doc-019 说「须平台组组长审批」，而「组长是周敏」只写在 doc-014 */
const MULTI_HOP_DEMO = 'q06'
/** 刹车演示：语料里根本没有答案，循环永远等不到「够了」 */
const BRAKE_DEMO = 'q19'

async function main(): Promise<void> {
  const mock = process.env.MOCK === '1'
  const chunks = loadChunks()
  const questions = loadGoldenSet()
  const retriever = await createRetriever(chunks)
  const assess: Assessor = mock ? createRuleAssessor(buildStats(chunks)) : createModelAssessor()

  console.log(`\n语料 ${new Set(chunks.map((c) => c.docId)).size} 篇 / ${chunks.length} 块`)
  console.log(
    `向量后端 ${retriever.backendName}｜自评 ${mock ? '规则替身（MOCK）' : 'claude-haiku-4-5-20251001'}`
  )
  console.log(
    `刹车：最多 ${BRAKES.maxRounds} 轮、累计材料 ${BRAKES.tokenBudget} token、重复查询即停`
  )

  console.log('\n一、工具描述（这段是写给模型看的提示词，不是注释）')
  console.log(`工具名：${SEARCH_TOOL.name}`)
  for (const line of SEARCH_TOOL.description.split('\n')) console.log(`   ${line}`)

  const demo = questions.find((q) => q.id === MULTI_HOP_DEMO)
  if (!demo) throw new Error(`golden set 里没有 ${MULTI_HOP_DEMO}`)
  console.log(`\n二、多跳轨迹（${demo.id}：${demo.question}）`)
  console.log(`   标准答案文档：${demo.answerDocIds.join('、')}`)
  const trace = await runAgenticRetrieval(demo.question, { retriever, assess })
  for (const hop of trace.hops) {
    console.log(`   第 ${hop.round} 轮｜查询「${hop.query}」`)
    console.log(
      `      命中文档 ${hop.docIds.slice(0, 5).join('、') || '（无）'}｜新增 ${hop.newDocIds.join('、') || '（无）'}｜读入 ${hop.tokensRead} token`
    )
    console.log(`      自评 ${hop.assessment.strategy}：${hop.assessment.reason}`)
  }
  console.log(
    `   停止原因 ${trace.stopReason}｜上下文文档 ${trace.contextDocIds.join('、')}｜${trace.contextTokens} token`
  )
  const multiHopOk = demo.answerDocIds.every((id) => trace.contextDocIds.includes(id))
  console.log(`   两篇答案文档${multiHopOk ? '都进了上下文 ✅' : '没有凑齐 ❌'}`)

  const brake = questions.find((q) => q.id === BRAKE_DEMO)
  if (!brake) throw new Error(`golden set 里没有 ${BRAKE_DEMO}`)
  console.log(`\n三、触发刹车（${brake.id}：${brake.question}）`)
  console.log('   这一问语料里没有答案，自评永远不会说「够了」——刹车是唯一的出口')
  const brakeRun = await runAgenticRetrieval(brake.question, { retriever, assess })
  for (const hop of brakeRun.hops) {
    console.log(
      `   第 ${hop.round} 轮｜查询「${hop.query}」｜自评 ${hop.assessment.strategy}：${hop.assessment.reason}`
    )
  }
  console.log(`   停止原因 ${brakeRun.stopReason}（不是「答出来了」，是被拦下来了）`)
  const tight = await runAgenticRetrieval(brake.question, {
    retriever,
    assess,
    brakes: { maxRounds: 9, tokenBudget: 400 },
  })
  console.log(
    `   把材料预算压到 400 token 再跑一次 → 停止原因 ${tight.stopReason}，只跑了 ${tight.hops.length} 轮`
  )

  // 第二类失败：不是没检索到，是检索到了却被自己的过滤器扔了。
  // 用「只认向量路」的严格门槛复现 D8 基线里那种失败：doc-021 排第 2 但余弦低于 0.2。
  const STRICT_GATES = { bm25MinScore: 999, vectorMinCosine: 0.2 }
  const strict = await createRetriever(chunks, { gates: STRICT_GATES })
  console.log('\n四、另一类失败：捞到了，却被自己的门槛扔了')
  console.log(
    `   把准入门槛收紧成「只认向量路」（余弦 ≥ ${STRICT_GATES.vectorMinCosine}，不看 BM25）`
  )
  const strictRows: string[][] = [['题号', '固定', 'Agentic', '放宽过', '停止原因']]
  let rescued = 0
  for (const q of questions.filter((x) => x.type === 'multi')) {
    const f = await runFixedRetrieval(q.question, strict)
    const g = await runAgenticRetrieval(q.question, { retriever: strict, assess })
    const fh = q.answerDocIds.every((d) => f.contextDocIds.includes(d))
    const gh = q.answerDocIds.every((d) => g.contextDocIds.includes(d))
    // 只统计**靠放宽救回来**的：q06 靠的是多跳，不算在这一栏里
    if (gh && !fh && g.hops.some((h) => h.relaxed)) rescued += 1
    strictRows.push([
      q.id,
      fh ? '命中' : '未命中',
      gh ? '命中' : '未命中',
      g.hops.some((h) => h.relaxed) ? '是' : '否',
      g.stopReason,
    ])
  }
  printTable(strictRows)
  console.log(`   被「降级放宽」救回来的：${rescued} 道`)
  console.log('   注意：这一类失败要靠放宽门槛，不是靠多跳。自评把它判成「查到半路」就会走错路——')
  console.log('   分类判错，容错就用反了。')

  console.log('\n五、固定流程 vs Agentic 流程（D8 的 20 题标准答案集）')
  const { rows, fixed, agentic } = await compare(questions, retriever, assess)
  printTable([
    ['账目', '固定流程', 'Agentic', '差'],
    [
      '召回率（可答题）',
      pct(fixed.recall),
      pct(agentic.recall),
      pct(agentic.recall - fixed.recall),
    ],
    [
      '召回率（single）',
      pct(fixed.recallSingle),
      pct(agentic.recallSingle),
      pct(agentic.recallSingle - fixed.recallSingle),
    ],
    [
      '召回率（multi）',
      pct(fixed.recallMulti),
      pct(agentic.recallMulti),
      pct(agentic.recallMulti - fixed.recallMulti),
    ],
    [
      '无答案题拒答率',
      pct(fixed.abstainRate),
      pct(agentic.abstainRate),
      pct(agentic.abstainRate - fixed.abstainRate),
    ],
    [
      '平均检索调用',
      fixed.avgRetrievalCalls.toFixed(2),
      agentic.avgRetrievalCalls.toFixed(2),
      `×${(agentic.avgRetrievalCalls / (fixed.avgRetrievalCalls || 1)).toFixed(2)}`,
    ],
    ['平均自评调用', fixed.avgAssessCalls.toFixed(2), agentic.avgAssessCalls.toFixed(2), '—'],
    [
      '平均耗时 ms',
      fixed.avgMs.toFixed(1),
      agentic.avgMs.toFixed(1),
      `×${(agentic.avgMs / (fixed.avgMs || 1)).toFixed(2)}`,
    ],
    [
      '平均上下文 token',
      fixed.avgContextTokens.toFixed(1),
      agentic.avgContextTokens.toFixed(1),
      (agentic.avgContextTokens - fixed.avgContextTokens).toFixed(1),
    ],
  ])
  console.log(
    '   拒答口径：固定流程看「有没有候选过门槛」，Agentic 看「循环结束时自评有没有说够了」——'
  )
  console.log('   两者量的是同一件事在不同位置的表现，不是同一个公式，比较时要连口径一起说。')
  console.log('   ⚠️ MOCK 下不走网络，耗时只反映本机计算量，不代表线上延迟；可信的是调用次数。')

  console.log('\n六、四道多跳题逐题看（这是今天的主战场）')
  printTable([
    ['题号', '固定', 'Agentic', '轮数', '停止原因'],
    ...rows
      .filter((r) => r.type === 'multi')
      .map((r) => [
        r.id,
        r.fixedHit ? '命中' : '未命中',
        r.agenticHit ? '命中' : '未命中',
        String(r.rounds),
        r.stopReason,
      ]),
  ])

  const flipped = rows.filter((r) => r.agenticHit && !r.fixedHit)
  const broke = rows.filter((r) => !r.agenticHit && r.fixedHit)
  console.log(`   多查几轮救回来的：${flipped.map((r) => r.id).join('、') || '（无）'}`)
  console.log(`   反而被拖垮的：${broke.map((r) => r.id).join('、') || '（无）'}`)

  const checks: Array<[string, boolean]> = [
    [
      '工具描述写全了「什么时候不用」和「query 怎么写」两条',
      /什么时候不用/.test(SEARCH_TOOL.description) && /query 写成/.test(SEARCH_TOOL.description),
    ],
    [
      `多跳题 ${MULTI_HOP_DEMO} 跑了不止一轮，且两篇答案文档都进了上下文`,
      trace.hops.length > 1 && multiHopOk,
    ],
    [
      '轨迹里每一轮都打出了查询、新增文档和自评理由',
      trace.hops.every((h) => h.assessment.reason.length > 0),
    ],
    [
      '无答案问题被刹车拦住，而不是无限查下去',
      ['max-rounds', 'token-budget', 'duplicate-query', 'give-up'].includes(brakeRun.stopReason),
    ],
    ['把材料预算压到 400 token，停止原因变成 token-budget', tight.stopReason === 'token-budget'],
    ['multi 档召回率高于固定流程', agentic.recallMulti > fixed.recallMulti],
    ['single 档召回率没有被拖垮', agentic.recallSingle >= fixed.recallSingle],
    ['严格门槛下，降级放宽至少救回一道多跳题', rescued >= 1],
    [
      '三笔账都报出来了：指标、调用次数、耗时',
      agentic.avgRetrievalCalls > 1 && agentic.avgAssessCalls > 0 && agentic.avgMs > 0,
    ],
  ]
  console.log('\n七、验收')
  for (const [name, ok] of checks) console.log(`   ${ok ? '✅' : '❌'} ${name}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
