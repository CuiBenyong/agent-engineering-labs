import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkFlat, loadDocs, type Chunk } from './corpus'
import { breakEvenQueries, countTokens, estimateBuildCost, estimateQueryCost, PRICES } from './cost'
import { CANDIDATE_K, evaluate, loadGoldenSet, type EvalResult } from './evaluate'
import {
  buildIndexes,
  buildSummaries,
  HEADER_INSTRUCTION,
  HEADER_MAX_TOKENS,
  indexTextOf,
  strippedTextOf,
  withHeaders,
} from './indexes'
import {
  createBm25Retriever,
  createHybridRetriever,
  createVectorRetriever,
  FUSED_TOP_K,
  PER_ROUTE_TOP_K,
  type Retriever,
} from './retrieve'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 打表
// ---------------------------------------------------------------------------

const width = (text: string): number =>
  [...text].reduce((w, ch) => w + (/[一-鿿（）：《》＋+]/.test(ch) ? 2 : 1), 0)

function printTable(rows: readonly (readonly string[])[]): void {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => width(r[col]))))
  rows.forEach((row, i) => {
    console.log(
      row.map((cell, col) => cell + ' '.repeat(Math.max(0, widths[col] - width(cell)))).join('  ')
    )
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  })
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mock = process.env.MOCK === '1'
  const docs = loadDocs()
  const questions = loadGoldenSet()
  console.log(
    `语料 ${docs.length} 篇，标准答案集 ${questions.length} 题` +
      `（single ${questions.filter((q) => q.type === 'single').length}、` +
      `multi ${questions.filter((q) => q.type === 'multi').length}、` +
      `none ${questions.filter((q) => q.type === 'none').length}），` +
      `${mock ? 'MOCK=1 离线' : '真实模型'}\n`
  )

  // 一、五种索引结构在同一套 D9 混合检索下的对照
  const indexes = await buildIndexes(docs)
  const results: EvalResult[] = []
  for (const built of indexes) {
    const retriever = await createHybridRetriever(built.chunks, indexTextOf)
    results.push(
      await evaluate(
        built.name,
        retriever,
        built.chunks,
        built.parents,
        questions,
        built.indexTokens,
        indexTextOf,
        // 最后一行是同一套带块头的索引，只把「装上下文时用不用块头」这一个变量改掉
        built.name.includes('只进索引') ? (c) => c.text : indexTextOf
      )
    )
  }

  console.log('一、五种索引结构（检索器全都是 D9 的混合检索 + 倒数排名融合 + 重排）')
  printTable([
    [
      '索引结构',
      '块数',
      '索引token',
      '召回率',
      'single',
      'multi',
      '答案平均名次',
      'nDCG@10',
      '上下文token',
    ],
    ...results.map(
      (r) =>
        [
          r.name,
          String(r.chunkCount),
          String(r.indexTokens),
          pct(r.recall),
          pct(r.recallSingle),
          pct(r.recallMulti),
          String(r.avgBestRank),
          r.ndcg.toFixed(4),
          String(r.avgContextTokens),
        ] as const
    ),
  ])

  // 二、复核 D4 的结论：块头到底在哪一路上有收益
  //    D4 的起点是「什么上下文都没有的裸块」，本天的基线块已经带着标题路径，
  //    所以要把三个层次一起摆出来才说得清那条负收益结论管到哪儿为止。
  const flat = docs.flatMap(chunkFlat)
  const flatHeaded = await withHeaders(docs, flat)
  const levels: { label: string; chunks: Chunk[]; indexText: (c: Chunk) => string }[] = [
    { label: '① 裸块（无任何上下文）', chunks: flat, indexText: strippedTextOf },
    { label: '② 标题路径（D9 基线）', chunks: flat, indexText: indexTextOf },
    { label: '③ 上下文块头', chunks: flatHeaded, indexText: indexTextOf },
  ]
  const routes: {
    label: string
    make: (c: Chunk[], t: (x: Chunk) => string) => Promise<Retriever>
  }[] = [
    { label: '纯 BM25', make: createBm25Retriever },
    { label: '纯向量', make: createVectorRetriever },
    { label: '混合检索', make: (c, t) => createHybridRetriever(c, t) },
  ]

  const routeReport: Record<string, EvalResult[]> = {}
  const routeRows: string[][] = []
  for (const route of routes) {
    const perLevel: EvalResult[] = []
    for (const level of levels) {
      perLevel.push(
        await evaluate(
          `${route.label} / ${level.label}`,
          await route.make(level.chunks, level.indexText),
          level.chunks,
          new Map(),
          questions,
          level.chunks.reduce((s, c) => s + countTokens(level.indexText(c)), 0),
          level.indexText
        )
      )
    }
    routeReport[route.label] = perLevel
    routeRows.push([
      route.label,
      perLevel.map((r) => pct(r.recall)).join(' → '),
      perLevel.map((r) => r.avgBestRank.toFixed(2)).join(' → '),
      perLevel.map((r) => r.ndcg.toFixed(4)).join(' → '),
    ])
  }

  console.log(
    '\n二、上下文的三个层次：① 裸块 → ② 标题路径（D9 基线）→ ③ 模型写的上下文块头\n' +
      '   （D4 在纯 BM25 下量到 ①→③ 是负收益，本表看它在三条检索路线上分别如何）'
  )
  printTable([['检索路线', '召回率 ①→②→③', '答案平均名次 ①→②→③', 'nDCG@10 ①→②→③'], ...routeRows])
  const indexTokenRow = levels.map((l) =>
    l.chunks.reduce((s, c) => s + countTokens(l.indexText(c)), 0)
  )
  console.log(
    `   索引 token：${indexTokenRow.join(' → ')}` +
      `（②比① +${pct(indexTokenRow[1] / indexTokenRow[0] - 1)}，③比② +${pct(indexTokenRow[2] / indexTokenRow[1] - 1)}）`
  )

  // 三、摘要索引：先定位文档，再在文档里细检索
  const summaries = await buildSummaries(docs)
  const summaryChunks: Chunk[] = summaries.map((s) => {
    const doc = docs.find((d) => d.docId === s.docId)
    if (!doc) throw new Error(`摘要 ${s.docId} 找不到文档`)
    return {
      docId: s.docId,
      chunkId: s.docId,
      text: s.text,
      headingPath: [],
      page: null,
      department: doc.department,
      updatedAt: doc.updatedAt,
      contentHash: doc.contentHash,
      parentId: null,
      header: null,
    }
  })
  const summaryRetriever = await createHybridRetriever(summaryChunks, (c) => c.text)
  const flatRetriever = await createHybridRetriever(flat, indexTextOf)
  const byChunkId = new Map(flat.map((c) => [c.chunkId, c]))

  const SUMMARY_TOP_DOCS = 3
  const twoStage: Retriever = {
    chunkCount: flat.length,
    indexedTokens: 0,
    async search(query) {
      // 练习 4：把两段式检索接起来。现在这里跳过了第一段，直接返回块检索的结果，
      //   所以表三的两行数字完全一样——摘要索引根本没生效。
      //   第一段：用 summaryRetriever 在 30 条摘要上检索，取前 SUMMARY_TOP_DOCS 个 docId；
      //   第二段：把块检索的结果按这几个 docId 过滤掉其余文档。
      //   注意 summaryRetriever 返回的是 chunkId，而摘要块的 chunkId 就是 docId 本身。
      //   做完之后回头看表三：召回率是涨了还是跌了？跌了说明什么？
      void summaryRetriever
      void SUMMARY_TOP_DOCS
      return flatRetriever.search(query)
    },
  }
  const summaryResult = await evaluate(
    `摘要索引（先定位 ${SUMMARY_TOP_DOCS} 篇再细检索）`,
    twoStage,
    flat,
    new Map(),
    questions,
    summaryChunks.reduce((s, c) => s + countTokens(c.text), 0)
  )
  const baseline = results[0]

  console.log('\n三、摘要索引：两段式检索（先用 30 条摘要定位文档，再在文档内部细检索）')
  printTable([
    ['方案', '召回率', 'single', 'multi', '答案平均名次', 'nDCG@10'],
    ...[baseline, summaryResult].map(
      (r) =>
        [
          r.name,
          pct(r.recall),
          pct(r.recallSingle),
          pct(r.recallMulti),
          String(r.avgBestRank),
          r.ndcg.toFixed(4),
        ] as const
    ),
  ])

  // 四、多跳与概括性问题：现有方案答不了的那两类
  const multiIds = questions.filter((q) => q.type === 'multi').map((q) => q.id)
  console.log('\n四、四道多跳题在各索引结构下的答案文档名次（21 表示候选池里根本没出现）')
  printTable([
    ['索引结构', ...multiIds],
    ...results.map(
      (r) =>
        [
          r.name,
          ...multiIds.map((id) => {
            const row = r.perQuestion.find((x) => x.id === id)
            return row ? `${row.bestRank}${row.hit ? ' ✅' : ' ❌'}` : '-'
          }),
        ] as const
    ),
  ])

  const OVERVIEW = '云梯科技这份知识库一共覆盖哪几个部门？每个部门大致在讲什么？'
  const overviewHits = (await flatRetriever.search(OVERVIEW)).slice(0, CANDIDATE_K)
  const overviewDocs = [...new Set(overviewHits.map((id) => byChunkId.get(id)?.docId))]
  console.log(
    `\n概括性问题「${OVERVIEW}」\n` +
      `  候选池 ${CANDIDATE_K} 条只覆盖 ${overviewDocs.length} 篇文档（全库 ${docs.length} 篇）：${overviewDocs.join(' ')}\n` +
      '  这一问的答案分散在全部 30 篇里，任何「取前 k 块」的检索都凑不齐——\n' +
      '  它要的不是某几段原文，而是全库的一个概括。树状递归聚合补的就是这个缺口。'
  )

  // 五、成本：一次性建索引 vs 每次查询
  const headedIndex = indexes[2]
  const build = estimateBuildCost(docs, flat, headedIndex.indexTokens, {
    instruction: HEADER_INSTRUCTION,
    maxTokens: HEADER_MAX_TOKENS,
  })
  const avgQuestionTokens = Math.round(
    questions.reduce((s, q) => s + countTokens(q.question), 0) / questions.length
  )
  // 重排读的是融合后的前 20 条，按加了块头的平均块长估
  const avgChunkTokens = Math.round(headedIndex.indexTokens / headedIndex.chunks.length)
  const rerankTokens = avgChunkTokens * FUSED_TOP_K
  const headedResult = results[2]
  const queryBase = estimateQueryCost(
    baseline.avgContextTokens,
    avgQuestionTokens,
    Math.round((baseline.indexTokens / baseline.chunkCount) * FUSED_TOP_K)
  )
  const queryHeaded = estimateQueryCost(
    headedResult.avgContextTokens,
    avgQuestionTokens,
    rerankTokens
  )

  console.log('\n五、成本（单价是占位值，见 .env.example；这张表里唯一实测的是 token 数）')
  printTable([
    ['科目', 'token', '说明'],
    [
      '一次性·不用缓存',
      String(build.naiveInputTokens + build.freshInputTokens),
      `${build.chunkCount} 块，每块把整篇重读一遍`,
    ],
    ['一次性·缓存写入', String(build.cacheWriteTokens), `${docs.length} 篇各写一次`],
    ['一次性·缓存读取', String(build.cacheReadTokens), '第二块起走缓存'],
    ['一次性·增量输入', String(build.freshInputTokens), '块正文 + 指令，缓存不了'],
    ['一次性·输出', String(build.outputTokens), `按每块上限 ${HEADER_MAX_TOKENS} token 保守估`],
    ['一次性·embedding', String(build.embedTokens), '带块头的索引全量向量化'],
    ['每次查询·重排读入', String(queryHeaded.rerankTokens), `前 ${FUSED_TOP_K} 条`],
    ['每次查询·生成输入', String(queryHeaded.genInTokens), '上下文 + 问题 + 系统提示'],
    ['每次查询·生成输出', String(queryHeaded.genOutTokens), '一次回答的估值'],
  ])
  console.log(
    `\n  按占位单价（生成输入 ${PRICES.genIn()} / 输出 ${PRICES.genOut()} / 缓存写 ${PRICES.cacheWrite()} / 缓存读 ${PRICES.cacheRead()} 美元每百万 token）：\n` +
      `  一次性建索引：不用缓存 $${build.naiveUsd.toFixed(4)}，开缓存 $${build.cachedUsd.toFixed(4)}，省 ${pct(build.savedRatio)}\n` +
      `  每次查询：基线 $${queryBase.usd.toFixed(6)}，加块头后 $${queryHeaded.usd.toFixed(6)}（+${pct(queryHeaded.usd / queryBase.usd - 1)}）\n` +
      `  一次性那笔钱摊到每次查询的 10% 以下，需要 ${breakEvenQueries(build.cachedUsd, queryHeaded.usd).toLocaleString('en-US')} 次查询——\n` +
      '  也就是说：建索引是小钱，每次查询多出来的那几百 token 才是长期账。'
  )

  // 六、离线环境的边界：向量路到底贡献了什么
  //    这一段不是优化，是**给上面所有数字加一个前提**。mock 哈希向量保留字面重合度，
  //    所以「混合检索」里的向量路很可能只是另一路关键词检索。不量一下，
  //    表二第③列的收益到底该记在谁头上就说不清。
  const routeProbe: { label: string; uniqueRatio: number; usefulQuestions: number }[] = []
  for (const level of levels.slice(1)) {
    const items = level.chunks.map((c) => ({ id: c.chunkId, text: level.indexText(c) }))
    const byId = new Map(level.chunks.map((c) => [c.chunkId, c]))
    // 深度必须是 PER_ROUTE_TOP_K：融合吃进去的就是每路前 50 条，
    // 拿默认的前 20 条去比会把「向量路独有」算高一大截
    const kwOnly = await createBm25Retriever(level.chunks, level.indexText, PER_ROUTE_TOP_K)
    const hybrid = await createHybridRetriever(level.chunks, level.indexText)
    void items
    let unique = 0
    let total = 0
    let useful = 0
    for (const q of questions) {
      const kw = new Set(await kwOnly.search(q.question))
      const fused = (await hybrid.search(q.question)).slice(0, FUSED_TOP_K)
      const uniq = fused.filter((id) => !kw.has(id))
      unique += uniq.length
      total += fused.length
      if (uniq.some((id) => q.answerDocIds.includes(byId.get(id)?.docId ?? ''))) useful += 1
    }
    routeProbe.push({
      label: level.label,
      uniqueRatio: total === 0 ? 0 : unique / total,
      usefulQuestions: useful,
    })
  }

  console.log('\n六、离线环境的边界：融合结果里有多少是向量路独有的')
  printTable([
    ['上下文层次', '前 20 条里向量路独有', '其中含答案文档的题数'],
    ...routeProbe.map(
      (r) => [r.label, pct(r.uniqueRatio), `${r.usefulQuestions}/${questions.length}`] as const
    ),
  ])
  console.log(
    '   向量路独有的候选一次都没带进答案文档，说明离线模式下混合检索的召回率基本全靠 BM25。\n' +
      '   所以表二第③列在「纯向量」上的涨幅，不能当成真实 embedding 会受益的证据。'
  )

  const report = {
    generatedAt: new Date().toISOString(),
    mock,
    corpus: { docCount: docs.length },
    goldenSet: questions.length,
    indexes: results.map(({ perQuestion, ...rest }) => ({ ...rest, perQuestion })),
    headerByRoute: routeReport,
    summaryIndex: summaryResult,
    routeProbe,
    cost: { build, queryBase, queryHeaded },
  }
  const out = join(HERE, '..', 'index-report.json')
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n对照表已写入 ${out}`)
  console.log(
    mock
      ? '注意：MOCK=1 下块头是按标题路径拼的规则版、向量是保留字面重合度的哈希向量。\n' +
          '这两条决定了上面的块头收益只能证明代码路径通了，不能代表真实模型写的块头能带来多少提升。'
      : '注意：真实模式下的数字取决于你的语料与模型，结论要连着前提一起写。'
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
