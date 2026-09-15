import 'dotenv/config'
import { ingest, loadDocs, TENANTS, type Department } from './corpus.js'
import { createVectorStore, inScope, type Scope } from './store.js'
import { createRetriever, RETRIEVAL } from './retrieve.js'
import { answer, CONTEXT_BUDGET, countTokens } from './answer.js'
import {
  aggregateByTenant,
  aggregateGlobal,
  failureCounts,
  gate,
  ledger,
  loadBaseline,
  loadGoldenSet,
  makeRecord,
  projectQuestion,
  renderMarkdown,
  writePanel,
  type Panel,
  type Record14,
} from './panel.js'
import { CAPSTONE_CONFIG, CAPSTONE_REQUIREMENT, decide, reviewConfig } from './decide.js'

/**
 * D14（solution）：多租户企业知识库问答 + 评估面板 + 决策地图。
 *
 *   MOCK=1 pnpm start            零依赖：哈希向量 + 内存索引，跑完自测退出
 *   DATABASE_URL=... pnpm start  同一份业务代码跑在 PostgreSQL + pgvector 上，多一项并排校验
 *
 * 它不是常驻服务：跑完自测就退出，退出码等于「有没有 ❌」。
 */

const checks: Array<{ name: string; ok: boolean; note: string }> = []
const check = (name: string, ok: boolean, note: string): void => {
  checks.push({ name, ok, note })
  console.log(`   ${ok ? '✅' : '❌'} ${name}`)
  console.log(`      ${note}`)
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

async function main(): Promise<void> {
  console.log('\n=== D14 综合项目：多租户企业知识库问答 ===\n')

  // --- 一、摄取：解析 → 切块 → 按租户投影 ---------------------------------
  const docs = loadDocs()
  const deptOf = new Map<string, Department>(docs.map((d) => [d.docId, d.department]))
  const chunks = ingest(docs, TENANTS)
  const store = await createVectorStore()
  const retriever = await createRetriever(chunks, store)

  console.log('一、摄取')
  console.log(`   语料 ${docs.length} 篇 → 块 ${chunks.length} 个`)
  console.log(
    `   embedding 后端 ${retriever.backendName}｜重排 ${retriever.rerankerName}｜索引 ${store.kind}`
  )
  for (const tenant of TENANTS) {
    console.log(
      `   ${tenant.name}：订阅 ${tenant.subscribes.join('/')}，索引 ${retriever.perTenantChunks.get(tenant.id) ?? 0} 块`
    )
  }
  console.log()

  const yunti = TENANTS[0]
  const hexing = TENANTS[1]
  const idsUnique = new Set(chunks.map((c) => c.chunkId)).size === chunks.length
  const yuntiChunks = retriever.perTenantChunks.get(yunti.id) ?? 0
  const hexingChunks = retriever.perTenantChunks.get(hexing.id) ?? 0
  // 试用工作区没导入工程文档，问它工程问题的正确行为是**按租户范围拒答**，
  // 而且话术要跟「库里没有」区分开——用户的下一步动作完全不同
  const scopeQ = '生产发布的灰度分几批放量？'
  const scopeAns = await answer(
    scopeQ,
    await retriever.retrieve(scopeQ, { tenantId: hexing.id }),
    true
  )
  console.log(`   试用工作区问「${scopeQ}」→ [${scopeAns.reason ?? 'answered'}] ${scopeAns.text}`)
  check(
    '1. 摄取时打标：两个工作区各有自己的块，范围外的问题按租户拒答',
    idsUnique &&
      yuntiChunks > 0 &&
      hexingChunks > 0 &&
      hexingChunks < yuntiChunks &&
      scopeAns.reason === 'out-of-tenant-scope',
    `${yunti.name} ${yuntiChunks} 块（四个部门全订阅），${hexing.name} ${hexingChunks} 块（只导入了产品文档）；` +
      `块 id 形如 ${chunks[0].chunkId}，${idsUnique ? '无重复' : '有重复'}；` +
      `试用工作区问工程文档走「${scopeAns.reason ?? 'answered'}」`
  )

  // --- 二、检索时过滤：范围谓词在打分之前生效 -----------------------------
  const supportScope: Scope = { tenantId: yunti.id, departments: ['support'] }
  const inSupportScope = chunks.filter((c) => inScope(c, supportScope)).length
  const probe = await retriever.probe('工单的响应时限是多久', supportScope)
  const expected = Math.min(RETRIEVAL.perRouteTopK, inSupportScope)
  const leaked = probe.vector
    .concat(probe.keyword)
    .map((id) => retriever.byId.get(id))
    .filter((c) => c && !inScope(c, supportScope)).length
  check(
    '2. 检索时过滤：不在范围里的块一次都没参与比较',
    probe.vector.length === expected && leaked === 0,
    `客服范围内共 ${inSupportScope} 块（全库 ${chunks.length} 块），向量一路返回 ${probe.vector.length} 条；` +
      `前置过滤应当返回 ${expected} 条——先全库排序取前 ${RETRIEVAL.perRouteTopK} 再筛的写法只剩个位数。越权块 ${leaked} 条`
  )

  const hexingProbe = await retriever.probe('生产发布的灰度分几批放量', { tenantId: hexing.id })
  const crossTenant = hexingProbe.fused
    .map((id) => retriever.byId.get(id))
    .filter((c) => c && c.tenantId !== hexing.id).length
  check(
    '3. 融合吃到了两路，且租户谓词是必填的',
    probe.fused.length > 0 &&
      probe.vector.some((id) => !probe.keyword.includes(id) && probe.fused.includes(id)) &&
      crossTenant === 0,
    `融合后前 ${probe.fused.length} 条里，有 ${probe.fused.filter((id) => !probe.keyword.includes(id)).length} 条是向量一路独有的；` +
      `拿试用工作区的范围检索，跨租户块 ${crossTenant} 条`
  )

  // --- 三、带引用的回答与引用校验 -----------------------------------------
  const askScope: Scope = { tenantId: yunti.id }
  const uploadQ = '网盘单个文件最大能上传多大？'
  const uploadCands = await retriever.retrieve(uploadQ, askScope)
  const uploadAns = await answer(uploadQ, uploadCands, false)
  const budgetQ = '公司每年团建预算是多少？'
  const budgetAns = await answer(budgetQ, await retriever.retrieve(budgetQ, askScope), false)
  console.log(`   问「${uploadQ}」→ ${uploadAns.text.slice(0, 60)}…`)
  check(
    '4. 回答带可校验的引用，拒答按原因分开记账',
    uploadAns.status === 'answered' &&
      uploadAns.verified.length > 0 &&
      uploadAns.contextTokens <= CONTEXT_BUDGET &&
      budgetAns.reason === 'no-admitted-candidate',
    `上传上限这一问装了 ${uploadAns.blocks.length} 块 / ${uploadAns.contextTokens} token（预算 ${CONTEXT_BUDGET}），` +
      `通过校验的引用 [${uploadAns.verified.join('][')}]，被拦下 ${uploadAns.rejected.length} 条；` +
      `团建预算走「${budgetAns.reason ?? 'answered'}」——三种拒答原因各自的话术不同`
  )

  // --- 四、评估面板：分租户跑全套 -----------------------------------------
  const questions = loadGoldenSet()
  const records: Record14[] = []
  let genIn = 0
  let genOut = 0
  for (const tenant of TENANTS) {
    for (const q of questions) {
      const projected = projectQuestion(q, tenant, deptOf)
      const scope: Scope = { tenantId: tenant.id }
      const candidates = await retriever.retrieve(q.question, scope)
      const result = await answer(q.question, candidates, projected.type === 'out-of-scope')
      genIn += result.contextTokens + countTokens(q.question)
      genOut += result.outTokens
      const relevant = chunks.filter(
        (c) => c.tenantId === tenant.id && projected.answerDocIds.includes(c.docId)
      ).length
      records.push(makeRecord(q, tenant, projected, candidates, result, relevant))
    }
  }

  const tenantMetrics = aggregateByTenant(records, retriever.perTenantChunks)
  const global = aggregateGlobal(records)
  const usage = retriever.usage()
  const panel: Panel = {
    generatedAt: new Date(0).toISOString(), // 固定时间戳：报告要能逐字比对，不能每跑一次就 diff 一行
    backend: retriever.backendName,
    reranker: retriever.rerankerName,
    store: store.kind,
    global,
    tenants: tenantMetrics,
    failures: failureCounts(records),
    ledger: ledger({
      questions: records.length,
      embedTokens: usage.embedTokens,
      rerankCalls: usage.rerankCalls,
      rerankInputTokens: usage.rerankInputTokens,
      genIn,
      genOut,
    }),
  }

  console.log(`\n${renderMarkdown(panel, TENANTS)}`)

  const spread =
    tenantMetrics.length < 2
      ? 0
      : Math.abs(tenantMetrics[0].recall - tenantMetrics[1].recall) +
        Math.abs(tenantMetrics[0].abstainRate - tenantMetrics[1].abstainRate)
  check(
    '5. 评估分租户统计，全局平均藏不住小租户的问题',
    tenantMetrics.length === TENANTS.length && spread > 0.05,
    tenantMetrics.length < TENANTS.length
      ? `面板上只有 ${tenantMetrics.length} 行（应该有 ${TENANTS.length} 行）：全部记录被混成一组，分租户的差异看不见了`
      : `两个工作区的召回率 ${pct(tenantMetrics[0].recall)} 对 ${pct(tenantMetrics[1].recall)}、` +
          `拒答率 ${pct(tenantMetrics[0].abstainRate)} 对 ${pct(tenantMetrics[1].abstainRate)}；` +
          `全局平均把它们抹成召回 ${pct(global.recall)} / 拒答 ${pct(global.abstainRate)} 一行`
  )

  const failures = panel.failures
  const notRetrieved = failures.find((f) => f.failure === 'not-retrieved')
  check(
    '6. 失败按模式分类，每一类指向不同的排查路径',
    failures.length >= 2 && Boolean(notRetrieved),
    failures.map((f) => `${f.failure} ${f.ids.length} 题`).join('｜') +
      `；「答案文档没进候选池」这一类是 ${notRetrieved?.ids.join('、') ?? '（无）'}——放宽门槛对它无效`
  )

  const l = panel.ledger
  check(
    '7. 三笔账：指标、延迟、钱各自成栏',
    l.embedTokensPerQ > 0 && l.rerankCallsPerQ > 0 && l.genInTokensPerQ > 0 && l.usdPerKQueries > 0,
    `每问 embedding ${l.embedTokensPerQ} token、重排 ${l.rerankCallsPerQ} 次、生成 ${l.genInTokensPerQ} in / ${l.genOutTokensPerQ} out；` +
      `每千问 $${l.usdPerKQueries}（占位单价），建模往返 ${l.modeledMs} ms`
  )

  // --- 五、决策地图：拿它复核自己在跑的配置 -------------------------------
  console.log('\n五、决策地图对照本项目实际配置')
  const divergences = reviewConfig(CAPSTONE_CONFIG, CAPSTONE_REQUIREMENT)
  for (const d of divergences) {
    console.log(`   · ${d.knob}：实际 ${d.actual}，地图建议 ${d.recommended}`)
    console.log(`     依据 ${d.because}`)
  }
  if (divergences.length === 0) console.log('   （逐项一致）')

  const bigCorp = decide({
    docs: 5_000_000,
    updatesPerDay: 20_000,
    latencyBudgetMs: 900,
    accuracy: 'high',
  })
  console.log('\n   同一张地图换一组输入（五百万篇 / 秒级 / 准确度优先）：')
  for (const d of bigCorp.decisions) console.log(`   · ${d.knob} = ${d.value}（by ${d.driver}）`)
  check(
    '8. 决策地图：四个输入变了，输出跟着变，且每条都指得出依据',
    bigCorp.config.index === 'dedicated' &&
      bigCorp.config.sync === 'incremental' &&
      bigCorp.config.rerank === true &&
      bigCorp.decisions.every((d) => d.because.length > 0) &&
      divergences.every((d) => d.because.length > 0),
    `本项目与地图有 ${divergences.length} 处不一致（${divergences.map((d) => d.knob).join('、') || '无'}），每处都带依据；` +
      `五百万篇那一组读出索引 ${bigCorp.config.index}、同步 ${bigCorp.config.sync}、Agentic ${bigCorp.config.agentic}`
  )

  // --- 六、回归闸门 --------------------------------------------------------
  const baseline = loadBaseline() ?? panel
  const clean = gate(panel, baseline)
  const worst = Math.min(...panel.tenants.map((t) => t.recall))
  const hurt: Panel = {
    ...panel,
    tenants: panel.tenants.map((t) => (t.recall === worst ? { ...t, recall: t.recall - 0.15 } : t)),
  }
  const caught = gate(hurt, baseline)
  check(
    '9. 回归闸门盯住五项，包括「最小租户召回率」',
    clean.passed && !caught.passed,
    `与存档基线比：${clean.passed ? '无退步' : `退步 ${clean.regressions.map((r) => r.name).join('、')}`}；` +
      `人为把最小租户召回率压低 15 个点，闸门报出「${caught.regressions.map((r) => r.name).join('、')}」`
  )

  const written = writePanel(panel, TENANTS)
  console.log(`\n面板已写出：${written.md}、${written.json}`)

  // --- 七、换真数据库（配了 DATABASE_URL 才跑） ---------------------------
  if (process.env.DATABASE_URL) {
    const memStore = await import('./store.js').then((m) => new m.MemoryVectorStore())
    const memRetriever = await createRetriever(chunks, memStore)
    const sqlRanks = (await retriever.probe(uploadQ, askScope)).vector.slice(0, 10)
    const memRanks = (await memRetriever.probe(uploadQ, askScope)).vector.slice(0, 10)
    check(
      '10. 内存索引与 pgvector 排出同一份名次',
      sqlRanks.length > 0 && sqlRanks.join('|') === memRanks.join('|'),
      `同一批向量、同一个范围，两种实现的前 ${sqlRanks.length} 名${sqlRanks.join('|') === memRanks.join('|') ? '逐条相同' : '不一致'}`
    )
    await memStore.close()
  } else {
    console.log('\n（没有 DATABASE_URL，跳过第 10 项：起了 docker compose 之后会多一项并排校验）')
  }

  await store.close()

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length > 0) {
    console.log(`未通过：${failed.map((c) => c.name).join('、')}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
