import 'dotenv/config'

import { CHUNKS, CHUNK_SIZE, EVAL_SET, OVERLAP, SOURCES } from './corpus'
import { buildContext, citationMetrics, renderSources, stripHallucinatedCitations } from './cite'
import { evaluate } from './eval'
import { CONTEXT_TOP_K, MODE_LABEL, POOL, bigrams, retrieve, rrfFuse } from './retrieve'
import { chat, embed, embeddingCostUsd } from './infra/model'
import { createStore, storeKind, type Store } from './infra/store'

/** 建库：切块 → 算向量 → 切词 → 落库。embedding 批量算，省的是往返延迟不是钱。 */
async function seed(store: Store): Promise<number> {
  await store.init()
  const batch = 32
  for (let i = 0; i < CHUNKS.length; i += batch) {
    const slice = CHUNKS.slice(i, i + batch)
    const vectors = await embed(slice.map((chunk) => chunk.content))
    await store.upsert(
      slice.map((chunk, index) => ({
        ...chunk,
        embedding: vectors[index],
        terms: bigrams(chunk.content),
      }))
    )
  }
  return embeddingCostUsd(CHUNKS.map((chunk) => chunk.content))
}

/** 完整的一次问答：检索 → 拼上下文 → 生成 → 剔除幻觉引用 → 附来源清单。 */
async function answer(store: Store, question: string): Promise<string> {
  const hits = (await retrieve(store, question, 'rerank')).slice(0, CONTEXT_TOP_K)
  const { prompt, citations } = buildContext(hits, question)
  const raw = await chat(prompt)
  const { text, hallucinated } = stripHallucinatedCitations(raw, citations)
  const note =
    hallucinated.length > 0 ? `（已剔除不存在的引用编号：${hallucinated.join('、')}）` : ''
  return `${text}${note}${renderSources(text, citations)}`
}

// --- 自检：MOCK=1 SELFTEST=1 pnpm start ---

const HINTS = [
  '切块用的是 512 字符 + 64 重叠，切成一整块等于没切',
  'bigrams 要把中文按相邻两字切开：整句话当成一个 token，关键词那一路查什么都查不到',
  'RRF 融合的是名次不是分数；把余弦相似度和 BM25 分数直接相加，量纲不同，编号那类 query 会被压掉',
  '三档的 recall@5 必须严格递增：涨不动说明关键词那一路或者重排没有真的接上',
  '不存在的引用编号要在后处理里剔除，并且计进指标，不能原样发给用户',
]

let failed = 0
function report(no: number, passed: boolean, line: string): void {
  if (!passed) failed += 1
  console.log(`[${no}/5] ${line} ${passed ? '✅' : `❌ ${HINTS[no - 1]}`}`)
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`

/** 按显示宽度补空格：中文一个字占两格，用 padEnd 会对不齐。 */
function pad(text: string, width: number): string {
  const shown = [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return text + ' '.repeat(Math.max(width - shown, 0))
}

async function selfTest(store: Store): Promise<void> {
  console.log(`=== 自检开始（仓库：${storeKind()}）===`)
  const costUsd = await seed(store)
  console.log(
    `      知识库：${SOURCES.length} 篇文档 → ${store.size()} 块，embedding 花费 ${costUsd.toFixed(6)} 美元`
  )

  // 1. 切块：512 + 64，且长文档真的被切成了多块
  const longest = Math.max(...CHUNKS.map((chunk) => chunk.content.length))
  const long = CHUNKS.filter((chunk) => chunk.sourceId === 's01')
  const lapped = long.length > 1 && long[1].content.includes(long[0].content.slice(-20))
  const ok1 = longest <= CHUNK_SIZE && long.length > 1 && lapped
  report(
    1,
    ok1,
    `切块：${CHUNKS.length} 块，最长 ${longest} 字符（上限 ${CHUNK_SIZE}），s01 切成 ${long.length} 块且重叠 ${OVERLAP} 字符`
  )

  // 2. 两路各有各的盲区——这是「为什么要两路」的全部理由
  const idQuery = 'E4032 是什么意思，可以让买家重试吗'
  const [idVec] = await embed([idQuery])
  const idDense = (await store.vectorSearch(idVec, POOL)).map((hit) => hit.chunkId)
  const idSparse = (await store.keywordSearch(bigrams(idQuery), POOL)).map((hit) => hit.chunkId)
  const zhQuery = '退款金额比我买的时候少了一截'
  const zhSparse = (await store.keywordSearch(bigrams(zhQuery), 5)).map((hit) => hit.chunkId)
  const vectorBlind = !idDense.slice(0, 5).includes('s07#0')
  const keywordSaves = idSparse[0] === 's07#0'
  const zhTokenized = zhSparse.includes('f02#0') || zhSparse.includes('s08#0')
  report(
    2,
    vectorBlind && keywordSaves && zhTokenized,
    `两路盲区：「${idQuery}」向量 top5 ${vectorBlind ? '没有' : '有'} s07#0，关键词 top1 是 ${idSparse[0] ?? '（空）'}；` +
      `中文 query 关键词 top5 = ${zhSparse.slice(0, 3).join(' ')}`
  )

  // 3. RRF：只看名次不看分数，把「一路第一、另一路没有」的那条拉进 top5
  // 两路给同一批候选排的名次（分数量纲故意差三个数量级，好看出 RRF 到底用没用它）
  const demo = rrfFuse([
    [
      { chunkId: 'a', score: 0.81 },
      { chunkId: 'b', score: 0.79 },
      { chunkId: 'c', score: 0.77 },
    ],
    [
      { chunkId: 'c', score: 24.5 },
      { chunkId: 'd', score: 11.2 },
      { chunkId: 'a', score: 9.8 },
    ],
  ])
  const expected = 1 / 61 + 1 / 63
  const formulaOk = demo[0].chunkId === 'a' && Math.abs(demo[0].score - expected) < 1e-9
  const fusedTop5 = (await retrieve(store, idQuery, 'hybrid')).slice(0, 5).map((c) => c.chunkId)
  report(
    3,
    formulaOk && fusedTop5.includes('s07#0'),
    `RRF：两路排名 [a,b,c] 与 [c,d,a] 融合后第一名是 ${demo[0].chunkId}（${demo[0].score.toFixed(5)}）；` +
      `编号那条 query 融合后 top5 = ${fusedTop5.slice(0, 3).join(' ')}…`
  )

  // 4. 三档 recall 递进——本天最重要的一项，改了任何参数都回来重跑
  const vector = await evaluate(store, 'vector')
  const hybrid = await evaluate(store, 'hybrid')
  const reranked = await evaluate(store, 'rerank')
  console.log(`      评估集 ${EVAL_SET.length} 条 query，每条人工标了 1-3 个必须召回的 chunkId`)
  for (const result of [vector, hybrid, reranked]) {
    console.log(
      `        ${pad(MODE_LABEL[result.mode], 30)} recall@5 ${pct(result.recall5)}` +
        `  recall@20 ${pct(result.recall20)}  MRR ${result.mrr.toFixed(3)}`
    )
  }
  const rising = vector.recall5 < hybrid.recall5 && hybrid.recall5 < reranked.recall5
  report(
    4,
    rising,
    `recall@5 递进：${pct(vector.recall5)} → ${pct(hybrid.recall5)} → ${pct(reranked.recall5)}`
  )
  if (reranked.worst.length > 0) {
    console.log(`      仍然漏掉的：${reranked.worst.map((w) => w.query).join('｜')}`)
  }

  // 5. 引用：编号、来源清单、幻觉引用的剔除与计数
  const question = '我对花生不能吃，买坚果礼盒安全吗'
  const text = await answer(store, question)
  const ok5 =
    /\[\d\]/.test(text) &&
    text.includes('来源：') &&
    citationMetrics.hallucinated === 1 &&
    !text.includes('[9]。')
  report(
    5,
    ok5,
    `引用：回答带编号与来源清单，幻觉引用计数 ${citationMetrics.hallucinated}/${citationMetrics.answers}`
  )
  console.log(`      问：${question}\n      答：${text.split('\n').join('\n      ')}`)

  console.log(`=== 自检结束：${failed === 0 ? '全部通过 ✅' : `${failed} 项未通过 ❌`} ===`)
}

async function main(): Promise<void> {
  const store = createStore()

  if (process.env.SELFTEST === '1') {
    await selfTest(store)
    await store.close()
    process.exit(failed === 0 ? 0 : 1)
  }

  const question = process.argv.slice(2).join(' ') || '我对花生不能吃，买坚果礼盒安全吗'
  const costUsd = await seed(store)
  console.log(`[建库] ${store.size()} 块（${storeKind()}），花费 ${costUsd.toFixed(6)} 美元`)
  console.log(`[提问] ${question}`)
  for (const mode of ['vector', 'hybrid', 'rerank'] as const) {
    const top = (await retrieve(store, question, mode)).slice(0, 3)
    console.log(
      `[${MODE_LABEL[mode]}] ${top.map((c) => `${c.chunkId}(${c.sourceTitle})`).join(' ')}`
    )
  }
  console.log(`[回答] ${await answer(store, question)}`)
  await store.close()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
