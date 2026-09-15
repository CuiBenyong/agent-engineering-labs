import 'dotenv/config'
import { buildIndex, search as bm25Search, DEFAULT_PARAMS, type BM25Index } from './bm25'
import { indexableText, loadCorpus, type Doc } from './corpus'
import { createEmbedBackend } from './embed'
import { createStore, toHalf, type NeighborHit, type VectorRow } from './store'

/**
 * D2 实验（solution）：把语料向量化写进 pgvector，按余弦距离查最近邻，
 * 并把结果和 D1 的 BM25 并排打印。
 *
 *   MOCK=1 pnpm start                    离线跑：哈希向量 + 内存向量库
 *   pnpm start                           连真实 pgvector（先 docker compose up -d 并配好 DATABASE_URL）
 *   MOCK=1 pnpm start "附件有多大限制"    只问一个问题
 *
 * 环境变量：MOCK、EMBED_BACKEND、EMBED_DIM、OPENAI_API_KEY、DATABASE_URL、TOP_K。
 */

const TOP_K = Number(process.env.TOP_K ?? 3)

/** 对照问题集：前两个考「换个说法」，第三个考精确匹配，第四个是普通查询 */
const QUESTIONS = [
  { id: 'v01', question: '单个文件最大能上传多大？', note: '原词提问，两路都该命中' },
  { id: 'v02', question: '附件体积有没有上限？', note: '换了说法：字面一个词都不重合' },
  { id: 'v03', question: '限流超了返回 429 吗？', note: '精确匹配：错误码这类词向量最容易糊掉' },
  { id: 'v04', question: '年假最多能结转几天到第二年？', note: '普通查询，作对照' },
]

function formatBm25(index: BM25Index, byId: Map<string, Doc>, question: string): string[] {
  const hits = bm25Search(index, question, TOP_K, DEFAULT_PARAMS)
  if (hits.length === 0) return ['    （倒排索引里一个词都没命中）']
  return hits.map((hit) => {
    const doc = byId.get(hit.docId)
    return `    ${hit.rank}. 分数 ${hit.score.toFixed(2).padStart(6)}  ${hit.docId}  ${doc?.title ?? ''}`
  })
}

function formatVector(hits: NeighborHit[]): string[] {
  if (hits.length === 0) return ['    （向量库里没有数据）']
  return hits.map(
    (hit) => `    ${hit.rank}. 距离 ${hit.distance.toFixed(4)}  ${hit.docId}  ${hit.title}`
  )
}

async function main(): Promise<void> {
  const docs = loadCorpus()
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  const bm25 = buildIndex(docs.map((doc) => ({ id: doc.id, text: indexableText(doc) })))

  const backend = createEmbedBackend()
  const store = await createStore()
  console.log(
    `语料 ${docs.length} 篇；embedding 后端 ${backend.name}，${backend.dimensions} 维；向量库 ${store.kind}`
  )

  // 1. 向量化。今天一篇文档只切一块（chunkId = doc-003#c01），真正的切块是 D4 的事
  const texts = docs.map((doc) => indexableText(doc))
  const vectors = await backend.embed(texts)
  const rows: VectorRow[] = docs.map((doc, i) => ({
    chunkId: `${doc.id}#c01`,
    docId: doc.id,
    title: doc.title,
    department: doc.department,
    updatedAt: doc.updated,
    text: texts[i],
    embedding: vectors[i],
  }))

  await store.init(backend.dimensions)
  await store.upsert(rows)
  console.log(`已写入 ${rows.length} 条向量；${await store.createIndex()}`)

  const single = process.argv.slice(2).join(' ').trim()
  const questions = single ? [{ id: 'q', question: single, note: '命令行提问' }] : QUESTIONS

  // 2. 两路检索并排打印：同一个问题，BM25 一列、向量一列
  for (const item of questions) {
    const [queryVec] = await backend.embed([item.question])
    const hits = await store.search(queryVec, { topK: TOP_K })
    console.log(`\n[${item.id}] ${item.question}    （${item.note}）`)
    console.log('  BM25（D1 的做法，只认字面）：')
    for (const line of formatBm25(bm25, byId, item.question)) console.log(line)
    console.log('  向量（余弦距离，越小越近）：')
    for (const line of formatVector(hits)) console.log(line)
  }

  // 3. 全精度 vs 半精度：占用直接砍半，名次通常不变
  const [probe] = await backend.embed([QUESTIONS[0].question])
  const full = await store.search(probe, { topK: TOP_K })
  const half = await store.search(probe, { topK: TOP_K, half: true })
  const size = await store.storageSize()
  const sameOrder = full.map((h) => h.docId).join(',') === half.map((h) => h.docId).join(',')
  const maxDrift = Math.max(
    ...full.map((hit, i) => Math.abs(hit.distance - (half[i]?.distance ?? hit.distance)))
  )
  console.log('\n全精度与半精度（同一个问题、同一批向量）：')
  console.log(
    `  占用：全精度 ${size.fullBytes} 字节，半精度 ${size.halfBytes} 字节` +
      `（${size.measured ? '数据库实测' : '按每维 4 字节与 2 字节估算'}）`
  )
  console.log(
    `  前 ${TOP_K} 名顺序${sameOrder ? '完全一致' : '发生了变化'}，距离最大偏差 ${maxDrift.toFixed(6)}`
  )
  // 挑绝对值最大的那一维来看：0 在两种精度下都是 0，看不出区别
  const sample = probe.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
  console.log(`  单个分量示例：${sample.toFixed(8)} → ${toHalf(sample).toFixed(8)}`)

  // 4. 查询计划：这一步只有连着真实数据库时才有东西可看
  const plan = await store.explain(probe, TOP_K)
  console.log('\n查询计划（有没有走索引）：')
  if (plan) {
    for (const line of plan) console.log(line)
    console.log(
      '  只有 30 行时规划器多半选全表扫描，这是对的；关掉 enable_seqscan 才看得到索引扫描。'
    )
  } else {
    console.log('  内存模式没有查询计划可看。起 docker compose、配上 DATABASE_URL 再跑一次就有了。')
  }

  await store.close()
  if (process.env.MOCK === '1') {
    console.log(
      '\nMOCK=1 用的是确定性哈希向量：它保留字面重合度，所以向量这一路的表现会很像关键词检索。' +
        '\n它验证的是代码路径（存得进、查得出、名次稳定），不是检索效果——效果要换成真模型才看得准。'
    )
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
