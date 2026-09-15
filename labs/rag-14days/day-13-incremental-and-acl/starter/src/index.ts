import 'dotenv/config'
import { chunkDocument, type Department } from './chunk.js'
import { buildSnapshot, loadCorpus, type Doc } from './corpus.js'
import { createEmbedBackend } from './embed.js'
import {
  Cache,
  IndexVersion,
  answerCacheKey,
  cachedEmbed,
  retrievalCacheKey,
  scopeKey,
  type KeyPolicy,
} from './cache.js'
import { createIndex, MemoryIndex, type Hit, type IndexStore } from './store.js'
import { applySync, planSync } from './sync.js'
import { Trace, countTokens } from './trace.js'

/**
 * D13（starter）：增量同步 + 权限下推 + 缓存分层 + 链路追踪与成本账。
 *
 *   MOCK=1 pnpm start          零依赖：哈希向量 + 内存索引，跑完十项自测后退出
 *   DATABASE_URL=... pnpm start 同一份业务代码跑在 PostgreSQL + pgvector 上
 *
 * 它不是常驻服务：跑完自测就退出，退出码等于「有没有 ❌」。
 */

const MODEL = process.env.ANSWER_MODEL ?? 'claude-sonnet-5'
const PROMPT_VERSION = 'v1'
const TOP_K = 4

// ---------------------------------------------------------------------------
// 查询链路：向量化 → 检索 → 重排 → 生成，每一段都记进 trace
// ---------------------------------------------------------------------------

/**
 * 重排的确定性替身（口径来自 D9，本天不重讲原理，只把它当一个要计时计费的环节）。
 * 打分方式是查询字符与块字符的重合度，可复现、不需要模型。
 */
function rerank(query: string, hits: Hit[]): Hit[] {
  const q = [...new Set([...query.toLowerCase().replace(/\s+/gu, '')])]
  const scored = hits.map((hit, i) => {
    const chars = new Set([...hit.text.toLowerCase()])
    // 按「问题里的字被这一块覆盖了多少」打分，而不是除以块长度——
    // 除以块长度会把短块顶上来，那是在奖励信息少，不是奖励相关
    const score = q.filter((c) => chars.has(c)).length / Math.max(q.length, 1)
    return { hit, score, i }
  })
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s, i) => ({ ...s.hit, rank: i + 1 }))
}

/** 拼上下文。每块前面标出块编号与部门，回答里要能引用得到 */
function buildContext(hits: Hit[]): string {
  return hits.map((h, i) => `[${i + 1}] (${h.chunkId} · ${h.department}) ${h.text}`).join('\n\n')
}

/**
 * 生成。MOCK 下不调模型：从上下文里挑出与问题字面重合最高的那一句，带上引用编号返回。
 * 这样离线也能看到「文档改了之后答案跟着变」这个现象——那是今天缓存那一节的全部意义。
 */
async function generate(
  question: string,
  hits: Hit[]
): Promise<{ text: string; tokensOut: number }> {
  const context = buildContext(hits)
  if (process.env.MOCK === '1' || !process.env.ANTHROPIC_API_KEY) {
    if (hits.length === 0) {
      return { text: '在你有权访问的资料里没有找到答案。', tokensOut: 0 }
    }
    // 只看排第一的那一块：它是重排给出的最佳答案来源，
    // 跨块挑句子会让答案在无关块之间跳来跳去，看不出「索引改了答案跟着改」这个现象
    const top = hits[0]
    const q = new Set([...question.toLowerCase().replace(/[\s？?。，,]/gu, '')])
    let best = { sentence: top.text.slice(0, 40), score: -1, n: 1 }
    for (const sentence of top.text.split(/[\n。！？]/u)) {
      const s = sentence.trim()
      if (s.length < 6) continue
      const score = [...new Set([...s])].filter((c) => q.has(c)).length / Math.sqrt(s.length)
      if (score > best.score) best = { sentence: s, score, n: 1 }
    }
    const text = `${best.sentence}。[${best.n}]`
    return { text, tokensOut: countTokens(text) }
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: '只根据给定资料回答，并在句末用 [n] 标出引用的块编号。资料里没有就直说没有。',
    messages: [{ role: 'user', content: `资料：\n${context}\n\n问题：${question}` }],
  })
  const text = res.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
  return { text, tokensOut: res.usage.output_tokens }
}

export interface AskDeps {
  store: IndexStore
  embed: (texts: string[]) => Promise<number[][]>
  backend: string
  version: IndexVersion
  answerCache: Cache<string>
  retrievalCache: Cache<Hit[]>
  policy: KeyPolicy
}

export interface AskResult {
  answer: string
  hits: Hit[]
  scanned: number
  cached: 'answer' | 'retrieval' | 'none'
  trace: Trace
}

/**
 * 一次问答。三层缓存从外往里查：先看答案缓存，再看检索缓存，最后才是向量缓存（在 embed 里）。
 * **权限范围一路带到 store.search 里，中途没有任何一处是「先查出来再筛掉」。**
 */
export async function ask(
  question: string,
  departments: Department[] | undefined,
  deps: AskDeps
): Promise<AskResult> {
  const trace = new Trace()
  const aKey = answerCacheKey(deps.policy, {
    question,
    departments,
    indexVersion: deps.version.value,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
  })
  const cachedAnswer = deps.answerCache.get(aKey)
  if (cachedAnswer !== undefined) {
    return { answer: cachedAnswer, hits: [], scanned: 0, cached: 'answer', trace }
  }

  const rKey = retrievalCacheKey({
    question,
    departments,
    topK: TOP_K,
    indexVersion: deps.version.value,
    backend: deps.backend,
  })
  let hits = deps.retrievalCache.get(rKey)
  let scanned = 0
  let cachedLevel: AskResult['cached'] = 'none'

  if (hits === undefined) {
    const endEmbed = trace.begin('embed')
    const [vector] = await deps.embed([question])
    endEmbed(countTokens(question))

    const endRetrieve = trace.begin('retrieve')
    const found = await deps.store.search(vector, { topK: TOP_K * 2, departments })
    endRetrieve()
    scanned = found.scanned

    const endRerank = trace.begin('rerank')
    hits = rerank(question, found.hits).slice(0, TOP_K)
    endRerank(found.hits.reduce((s, h) => s + countTokens(h.text), 0))

    deps.retrievalCache.set(rKey, hits)
  } else {
    cachedLevel = 'retrieval'
  }

  const endGenerate = trace.begin('generate')
  const { text, tokensOut } = await generate(question, hits)
  endGenerate(countTokens(buildContext(hits)) + countTokens(question), tokensOut)

  deps.answerCache.set(aKey, text)
  return { answer: text, hits, scanned, cached: cachedLevel, trace }
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail}`)
}

const UPLOAD_Q = '单个文件的上传上限是多少'

async function seed(store: IndexStore, embed: (t: string[]) => Promise<number[][]>, docs: Doc[]) {
  const indexed = await store.fingerprints()
  const plan = planSync(indexed, docs, { detectDeletes: true, dedupe: true })
  return applySync(store, embed, docs, plan)
}

async function main(): Promise<void> {
  const backend = createEmbedBackend()
  const embedCache = new Cache<number[]>('L3 向量')
  const embed = cachedEmbed((texts) => backend.embed(texts), embedCache, backend.name)
  const store = await createIndex(false)
  await store.init(backend.dimensions)
  const version = new IndexVersion()

  console.log(`存储：${store.kind}　向量：${backend.name}　模型：${MODEL}\n`)

  // --- 1. 首次全量索引 ---------------------------------------------------
  const base = loadCorpus()
  const parseEnd = new Trace().begin('parse')
  const first = await seed(store, embed, base)
  parseEnd()
  const stats1 = await store.stats()
  check(
    '1. 首次全量索引',
    stats1.docs === 30 &&
      stats1.chunks === first.embeddedChunks &&
      stats1.chunks === stats1.embeddings,
    `30 篇 → ${first.embeddedChunks} 块，索引里 documents=${stats1.docs} chunks=${stats1.chunks} embeddings=${stats1.embeddings}`
  )

  // 先问一次，把答案与检索结果灌进缓存（这是后面制造陈旧答案的前提）
  const answerCache = new Cache<string>('L1 答案')
  const retrievalCache = new Cache<Hit[]>('L2 检索')
  const buggy: AskDeps = {
    store,
    embed,
    backend: backend.name,
    version,
    answerCache,
    retrievalCache,
    policy: 'buggy',
  }
  const before = await ask(UPLOAD_Q, ['product'], buggy)
  const sawOld = before.answer.includes('200 MB')

  // --- 2. 增量对账：五种变更 ---------------------------------------------
  const snapshot = buildSnapshot(base)
  const indexed = await store.fingerprints()
  const plan = planSync(indexed, snapshot.docs, { detectDeletes: true, dedupe: true })
  const ok2 =
    plan.added.join() === 'doc-031' &&
    plan.modified.join() === 'doc-006' &&
    plan.deleted.join() === 'doc-030' &&
    plan.duplicates.length === 1 &&
    plan.unchanged.includes('doc-005')
  check(
    '2. 增量对账认出五种变更（含 \\r\\n 重传判为未变）',
    ok2,
    `新增 ${plan.added.join() || '-'}｜修改 ${plan.modified.join() || '-'}｜删除 ${
      plan.deleted.join() || '-'
    }｜重复 ${plan.duplicates.map((d) => `${d.docId}→${d.canonicalOf}`).join() || '-'}｜未变 ${
      plan.unchanged.length
    } 篇（doc-005 换成 \\r\\n 后${plan.unchanged.includes('doc-005') ? '仍判为未变' : '被误判为修改'}）`
  )

  const callsBefore = embed.calls()
  const second = await applySync(store, embed, snapshot.docs, plan)
  if (plan.added.length + plan.modified.length + plan.deleted.length > 0) version.bump()
  const saved = 1 - second.embeddedChunks / second.fullRebuildChunks
  check(
    '3. 只重算受影响的块',
    second.embeddedChunks < second.fullRebuildChunks * 0.2,
    `这次只向量化 ${second.embeddedChunks} 块，全量重建要 ${second.fullRebuildChunks} 块，省了 ${(
      saved * 100
    ).toFixed(1)}%；本次新增 embed 调用 ${embed.calls() - callsBefore} 次`
  )

  // --- 4. 删除不留残留 ---------------------------------------------------
  const fps = await store.fingerprints()
  const stats2 = await store.stats()
  const ghostVec = await embed(['doc-030'])
  const ghostHits = await store.search(ghostVec[0], { topK: 30 })
  const ghost = ghostHits.hits.some((h) => h.docId === 'doc-030')
  check(
    '4. 删除的文档连块带向量一起消失',
    !fps.has('doc-030') && !ghost && stats2.chunks === stats2.embeddings,
    `documents 里${fps.has('doc-030') ? '还留着' : '已没有'} doc-030；检索前 30 名里${
      ghost ? '仍能捞到它' : '一条都捞不到'
    }；chunks=${stats2.chunks} embeddings=${stats2.embeddings}`
  )

  // --- 5. 权限过滤下推到检索 ---------------------------------------------
  const qVec = (await embed([UPLOAD_Q]))[0]
  const wide = await store.search(qVec, { topK: 8 })
  const narrow = await store.search(qVec, { topK: 8, departments: ['support'] })
  const leaked = narrow.hits.filter((h) => h.department !== 'support')
  check(
    '5. 权限过滤下推进检索，越权的行一次都没参与比较',
    leaked.length === 0 && narrow.scanned < wide.scanned,
    `不带范围：比较 ${wide.scanned} 行，命中部门 ${[
      ...new Set(wide.hits.map((h) => h.department)),
    ].join('/')}；限定 support：比较 ${narrow.scanned} 行，命中部门 ${
      [...new Set(narrow.hits.map((h) => h.department))].join('/') || '-'
    }${leaked.length ? `（泄露 ${leaked.length} 条）` : ''}`
  )

  // --- 6. 索引隔离 vs 行级过滤 -------------------------------------------
  const isolated = new MemoryIndex(true)
  await isolated.init(backend.dimensions)
  await seed(
    isolated,
    embed,
    snapshot.docs.filter((d) => d.id !== 'doc-032')
  )
  const isoHits = await isolated.search(qVec, { topK: 8, departments: ['support'] })
  const sameOrder =
    isoHits.hits.map((h) => h.chunkId).join() === narrow.hits.map((h) => h.chunkId).join()
  check(
    '6. 索引隔离与行级过滤：名次一致，扫描量不同',
    sameOrder && isoHits.examined < narrow.examined,
    `行级过滤：碰过 ${narrow.examined} 行、比较 ${narrow.scanned} 行；索引隔离：碰过 ${
      isoHits.examined
    } 行、比较 ${isoHits.scanned} 行；前 ${isoHits.hits.length} 名${
      sameOrder ? '完全一致' : '不一致'
    }`
  )
  await isolated.close()

  // --- 7. 缓存该失效却没失效 ---------------------------------------------
  const stale = await ask(UPLOAD_Q, ['product'], buggy)
  const crossScope = await ask(UPLOAD_Q, ['hr'], buggy)
  const fixed: AskDeps = { ...buggy, policy: 'fixed', answerCache: new Cache('L1 答案（修好）') }
  const fresh = await ask(UPLOAD_Q, ['product'], fixed)
  const freshHr = await ask(UPLOAD_Q, ['hr'], fixed)
  const bugReproduced =
    sawOld &&
    stale.cached === 'answer' &&
    stale.answer.includes('200 MB') &&
    crossScope.cached === 'answer'
  const bugFixed = fresh.answer.includes('500 MB') && !freshHr.answer.includes('500 MB')
  check(
    '7. 缓存「该失效却没失效」复现并修好',
    bugReproduced && bugFixed,
    `key 只有问题时：同步后再问仍返回「${stale.answer.slice(0, 24)}…」（缓存命中，索引已是 500 MB）；` +
      `换 hr 用户来问${crossScope.cached === 'answer' ? '直接命中了 product 的答案' : '没有串'}。` +
      `key 补上索引版本与权限范围后：product 用户得到「${fresh.answer.slice(
        0,
        24
      )}…」，hr 用户得到「${freshHr.answer.slice(0, 24)}…」`
  )

  // --- 8. 向量缓存 --------------------------------------------------------
  const callsA = embed.calls()
  await ask(UPLOAD_Q, ['eng'], fixed)
  await ask(UPLOAD_Q, ['eng'], fixed)
  const newCalls = embed.calls() - callsA
  check(
    '8. 向量缓存跨查询、跨同步都命中',
    newCalls === 0 && embedCache.stats.hits > 0,
    `同一个问题再问两次，新增 embed 调用 ${newCalls} 次；L3 累计命中率 ${(
      embedCache.hitRate * 100
    ).toFixed(1)}%，缓存里 ${embedCache.size} 条`
  )

  // --- 9. 追踪与成本账 ----------------------------------------------------
  const traced = await ask('回收站里的文件能保留多久', ['product', 'support'], {
    ...fixed,
    answerCache: new Cache('L1 答案（追踪用）'),
    retrievalCache: new Cache('L2 检索（追踪用）'),
  })
  console.log('\n   —— 一次问答的追踪记录 ——')
  for (const line of traced.trace.lines()) console.log(line)
  const spot = traced.trace.hotspots()
  console.log()
  check(
    '9. 查询链路的四段分别记到了时间与花费',
    traced.trace.spans.length === 4 && traced.trace.totalUsd > 0,
    `记了 ${traced.trace.spans.length} 段（向量化/检索/重排/生成；解析在摄取侧单独计时），合计 ${traced.trace.totalMs} ms、$${traced.trace.totalUsd.toFixed(
      8
    )}；最慢的是「${spot.slowest}」，最贵的是「${spot.costliest}」`
  )

  // --- 10. 换 embedding 模型：双写与切换 ----------------------------------
  const all = await store.fingerprints()
  const docsById = new Map(snapshot.docs.map((d) => [d.id, d]))
  const rows: Array<{ chunkId: string; embedding: number[] }> = []
  for (const docId of all.keys()) {
    const doc = docsById.get(docId)
    if (!doc || all.get(docId)?.canonicalOf) continue
    const chunks = chunkDocument(doc)
    // 新模型维度不同是常态，这里用降维模拟「另一套向量」：关键是它写在另一列，老列一动不动
    const vectors = await backend.embed(
      chunks.map((c) => c.text),
      { dimensions: backend.dimensions }
    )
    chunks.forEach((c, i) => rows.push({ chunkId: c.chunkId, embedding: vectors[i] }))
  }
  await store.writeV2(rows)
  const v1Hits = await store.search(qVec, { topK: 5, departments: ['product'] })
  const v2Hits = await store.search(qVec, { topK: 5, departments: ['product'], column: 'v2' })
  check(
    '10. 双写第二套向量，切列即切模型，老列全程可用',
    rows.length > 0 && v2Hits.hits.length === v1Hits.hits.length,
    `回填 ${rows.length} 条 v2 向量期间 v1 一直可查；切到 v2 后前 ${v2Hits.hits.length} 名为 ${v2Hits.hits
      .map((h) => h.chunkId)
      .join(' ')}`
  )

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
