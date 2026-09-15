import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import Fastify from 'fastify'
import { z } from 'zod'
import { BASELINE_D1_PATH, CORPUS_DIR, PORT, isMock, loadConfig } from './config'
import { createEmbedder } from './embed'
import { createStore, type StoredChunk } from './store'
import { Retriever, type Candidate } from './retrieve'
import { answerQuestion, toBlocks, verifyCitations, REFUSAL } from './answer'
import { ingest } from './ingest'

/**
 * D7 服务入口（solution）。
 *
 *   MOCK=1 SELFTEST=1 pnpm start   起服务、自己给自己发请求、逐项打印 ✅/❌，跑完退出
 *   MOCK=1 pnpm start              常驻，供你手动 curl
 *   docker compose up -d && DATABASE_URL=postgres://rag:rag@localhost:5557/rag pnpm start
 *
 * 三个接口：
 *   POST /ingest          投喂文档（给一个目录）
 *   POST /ask             发起提问，返回带引用的回答与用到的块
 *   GET  /chunks/:chunkId 查看某个块的原文（引用要能点开，否则等于没有引用）
 */

const cfg = loadConfig()
const store = createStore()
const embedder = createEmbedder(cfg)
const retriever = new Retriever(store, cfg, embedder)

const app = Fastify({ logger: false })
const askBody = z.object({ question: z.string().min(1) })
const ingestBody = z.object({ dir: z.string().optional() })

app.get('/health', async () => ({
  ok: true,
  store: store.kind,
  mock: isMock(),
  config: {
    chunking: cfg.chunking.strategy,
    embedding: embedder.name,
    routes: cfg.retrieval.routes,
  },
  ...(await store.stats()),
}))

app.post('/ingest', async (req, reply) => {
  const parsed = ingestBody.safeParse(req.body ?? {})
  if (!parsed.success) return reply.code(400).send({ error: 'dir 必须是字符串' })
  const report = await ingest(parsed.data.dir ?? CORPUS_DIR, store, cfg, embedder)
  // 摄取完必须刷新关键词索引，否则新入库的块向量能查到、关键词查不到——
  // 这种「一路能查一路查不到」的故障最难排，因为它看起来只是「结果怪怪的」
  const indexed = await retriever.refresh()
  return { ...report, indexed }
})

app.post('/ask', async (req, reply) => {
  const parsed = askBody.safeParse(req.body ?? {})
  if (!parsed.success) return reply.code(400).send({ error: 'question 不能为空' })
  const question = parsed.data.question
  const { candidates, used, routes } = await retriever.retrieve(question)
  const result = await answerQuestion(question, used, cfg)
  return {
    question,
    ...result,
    routes,
    used: used.map((c) => ({
      chunkId: c.chunk.chunkId,
      docId: c.chunk.docId,
      title: c.chunk.headingPath.join(' > ') || c.chunk.docId,
      department: c.chunk.department,
      updatedAt: c.chunk.updatedAt,
      routes: c.routes,
      bm25: c.bm25 ?? null,
      vector: c.vector ?? null,
      fused: Number(c.fused.toFixed(4)),
    })),
    // 把没过门槛的候选也带出来：排查「为什么没答上」时，第一件事就是看它到底捞回了什么
    rejected: candidates
      .filter((c) => !c.admitted)
      .map((c) => ({ chunkId: c.chunk.chunkId, bm25: c.bm25 ?? null, vector: c.vector ?? null })),
  }
})

app.get<{ Params: { chunkId: string } }>('/chunks/:chunkId', async (req, reply) => {
  // chunkId 里带着 #，做成路径参数时客户端必须 encodeURIComponent，
  // 否则 # 后面会被当成 URL 片段整段丢掉，服务端只收到 doc-006
  const chunk = await store.getChunk(req.params.chunkId)
  if (!chunk) return reply.code(404).send({ error: `没有这个块：${req.params.chunkId}` })
  return chunk
})

// ---------------------------------------------------------------------------
// 自测：起服务 → 摄取 → 三个代表性问题 → 查块原文 → 与 D1 基线并排
// ---------------------------------------------------------------------------

interface Check {
  name: string
  ok: boolean
  detail: string
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

async function ask(question: string): Promise<{
  answer: string
  refused: boolean
  citations: { n: number; chunkId: string; overlap: number }[]
  rejectedCitations: string[]
  used: { chunkId: string; docId: string; routes: string[]; vector: number | null }[]
}> {
  return (await post('/ask', { question })) as never
}

async function selftest(): Promise<number> {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  const ingested = (await post('/ingest', {})) as { docs: number; chunks: number; indexed: number }
  add(
    '摄取：一条命令把 30 篇语料解析、切块、向量化并入库',
    ingested.docs === 30 && ingested.chunks > 30 && ingested.indexed === ingested.chunks,
    `${ingested.docs} 篇 → ${ingested.chunks} 块，关键词索引 ${ingested.indexed} 块`
  )

  const b01 = await ask('单个文件最大能上传多大？')
  const docs01 = new Set(b01.used.map((u) => u.docId))
  add(
    '带引用问答：两篇结论打架的文档同时进上下文',
    docs01.has('doc-006') && docs01.has('doc-024') && b01.citations.length > 0,
    `命中 ${[...docs01].join(' ')}，${b01.citations.length} 条引用全部回查通过`
  )

  add(
    '向量这一路真的算出了相似度（不是一排零）',
    (b01.used[0]?.vector ?? 0) > 0,
    `最高分块 ${b01.used[0]?.chunkId} 的余弦相似度 ${(b01.used[0]?.vector ?? 0).toFixed(3)}`
  )

  const b03 = await ask('生产数据库主备切换需要谁审批？')
  const docs03 = new Set(b03.used.map((u) => u.docId))
  add(
    '多跳仍然答不了（这是留给 D12 的债，不是 bug）',
    docs03.has('doc-019') && !docs03.has('doc-014'),
    `命中 ${[...docs03].join(' ')}；「平台组组长是谁」写在 doc-014 里，一次都没被捞回来`
  )

  const b08 = await ask('公司每年团建预算是多少？')
  add(
    '证据不足时拒答，而不是硬编',
    b08.refused && b08.answer.startsWith(REFUSAL),
    `回答：${b08.answer.slice(0, 24)}`
  )

  const someChunk = b01.used[0]?.chunkId ?? ''
  const res = await fetch(`http://127.0.0.1:${PORT}/chunks/${encodeURIComponent(someChunk)}`)
  const chunk = (await res.json()) as StoredChunk
  add(
    '每条引用都能点开看原文',
    res.status === 200 && chunk.chunkId === someChunk && (chunk.text?.length ?? 0) > 0,
    `${someChunk} → ${chunk.text?.slice(0, 28).replace(/\n/g, ' ')}…`
  )

  // 引用校验单独验一次：光看正常问答看不出校验有没有生效，得喂两条坏引用进去。
  // 两种坏法都要覆盖：编号越界（好抓），以及编号是真的但内容对不上（难抓，只有算重合度才发现）
  const probeBlocks = toBlocks([{ chunk } as unknown as Candidate])
  const probe = verifyCitations(
    `${(chunk.text ?? '').slice(0, 24)}[1]。公司每年团建预算是八万元[1]。这一句引用了不存在的块[9]。`,
    probeBlocks
  )
  add(
    '引用校验：越界编号与对不上的引用都进不了返回结果',
    probe.citations.length === 1 &&
      probe.rejected.some((r) => r.startsWith('[9]')) &&
      probe.rejected.some((r) => r.includes('重合度')),
    `通过 ${probe.citations.length} 条（重合度 ${probe.citations[0]?.overlap}），拦下 ${probe.rejected.length} 条：${probe.rejected.join('；')}`
  )

  // 与 D1 的基线并排：同样 9 个问题，看命中的文档变了没有、该拒的还拒不拒
  const baseline = JSON.parse(readFileSync(BASELINE_D1_PATH, 'utf8')) as {
    questions: { id: string; question: string; used: string[]; refused: boolean }[]
  }
  const rows: string[] = []
  let sameRefusal = 0
  let changedHits = 0
  const comparison = []
  for (const q of baseline.questions) {
    const now = await ask(q.question)
    const nowDocs = [...new Set(now.used.map((u) => u.docId))]
    const overlap = nowDocs.filter((d) => q.used.includes(d)).length
    if (now.refused === q.refused) sameRefusal += 1
    // 命中集合变没变，按文档粒度比：块粒度检索必然让集合变动，但变好变坏今天判不了
    if (nowDocs.join(',') !== [...q.used].join(',')) changedHits += 1
    rows.push(
      `  ${q.id}  D1: ${(q.used.join(',') || '（拒答）').padEnd(26)} → D7: ${nowDocs.join(',') || '（拒答）'}`
    )
    comparison.push({
      id: q.id,
      question: q.question,
      d1: { used: q.used, refused: q.refused },
      d7: { used: nowDocs, chunks: now.used.map((u) => u.chunkId), refused: now.refused },
      overlap,
    })
  }
  add(
    '9 个基线问题跑通，拒答行为与 D1 一致',
    sameRefusal === baseline.questions.length,
    `${sameRefusal}/${baseline.questions.length} 个问题的拒答判断与 D1 相同；` +
      `其中 ${changedHits} 个问题的命中文档集合变了（变好变坏要等 D8 的评估才能说）`
  )

  console.log('\n与 D1 基线并排（文档粒度）：')
  console.log(rows.join('\n'))

  // 诊断而不是断言：向量这一路到底有没有独立贡献。
  // MOCK 的哈希向量保留的是字面重合度，所以它几乎总是跟 BM25 命中同一批块——
  // 这不是 bug，是 mock 向量的性质。换成真实 embedding 之后这个数字才有意义。
  const vectorOnly = b01.used.filter((u) => !u.routes.includes('bm25'))
  console.log(
    `\n诊断：b01 的 ${b01.used.length} 个入选块里，只靠向量这一路进来的有 ${vectorOnly.length} 个` +
      `${isMock() ? '（MOCK 下这个数通常是 0，见 README 的 MOCK 说明）' : ''}`
  )

  console.log('\n自测结果：')
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}\n     ${c.detail}`)

  writeFileSync(
    'selftest-report.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), store: store.kind, mock: isMock(), config: cfg, checks, comparison }, null, 2)}\n`
  )
  const failed = checks.filter((c) => !c.ok).length
  console.log(
    `\n${checks.length - failed}/${checks.length} 项通过，详情已写入 selftest-report.json`
  )
  return failed === 0 ? 0 : 1
}

async function main(): Promise<void> {
  await store.init() // 可重复执行的迁移；compose 起库时已经跑过一遍，这里是兜底
  await retriever.refresh()
  await app.listen({ port: PORT, host: '127.0.0.1' })
  const stats = await store.stats()
  console.log(
    `RAG 服务已启动：http://127.0.0.1:${PORT}\n` +
      `  存储 ${store.kind}｜切块 ${cfg.chunking.strategy}｜向量 ${embedder.name}｜检索 ${cfg.retrieval.routes.join('+')}` +
      `｜库里 ${stats.docs} 篇 ${stats.chunks} 块${isMock() ? '｜MOCK=1（生成用模板拼接）' : ''}`
  )

  if (process.env.SELFTEST === '1') {
    const code = await selftest()
    await app.close()
    await store.close()
    process.exit(code)
  }
  console.log('  POST /ingest ｜ POST /ask ｜ GET /chunks/:chunkId ｜ GET /health')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
