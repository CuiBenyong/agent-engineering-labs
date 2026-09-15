import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { buildIndex, search, DEFAULT_PARAMS, type BM25Index, type BM25Params } from './bm25'
import { indexableText, loadCorpus, type Doc } from './corpus'
import { answer, REFUSAL, type Passage } from './generate'

/**
 * D1 实验（starter）：纯 BM25 的最小 RAG。四个练习点分布在
 * src/tokenize.ts（练习 1）、src/bm25.ts（练习 2、3）、本文件的 retrieve（练习 4）。
 *
 *   pnpm start                     跑基线问题集，打印检索结果并写出 baseline.json
 *   pnpm start "回收站保留多久"     回答单个问题
 *
 * 可调环境变量：K1、B、TOP_K、MIN_SCORE、MOCK。
 */

/** 基线问题集。id 用 bNN，跟 D4 之后的标准答案集（q01…）区分开 */
const BASELINE_QUESTIONS = [
  { id: 'b01', question: '单个文件最大能上传多大？' },
  { id: 'b02', question: '删掉的文件在回收站里能保留多久？' },
  { id: 'b03', question: '生产数据库主备切换需要谁审批？' },
  { id: 'b04', question: '变更评审会什么时候开，二级变更要提前几天提单？' },
  { id: 'b05', question: '开放 API 的默认限流是多少？超了会返回什么状态码？' },
  { id: 'b06', question: '年假最多能结转几天到第二年？' },
  { id: 'b07', question: 'P0 故障要求多久之内响应？' },
  // 下面两个问题语料里都没有答案，但失败方式不一样：
  // b08 一个关键词都对不上，分数低于阈值，检索侧就能挡掉；
  // b09 满篇都是「报销」，分数很高，检索侧挡不住，只能靠生成侧允许拒答。
  { id: 'b08', question: '公司每年团建预算是多少？' },
  { id: 'b09', question: '云梯科技给员工报销手机话费吗？' },
]

function readParams(): BM25Params {
  return {
    k1: Number(process.env.K1 ?? DEFAULT_PARAMS.k1),
    b: Number(process.env.B ?? DEFAULT_PARAMS.b),
  }
}

const TOP_K = Number(process.env.TOP_K ?? 3)
/** 低于这个分就当作「没检索到」。不设阈值的话，任何问题都会捞回三篇最不相干的文档 */
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 6)

interface Retrieved {
  passages: Passage[]
  raw: { rank: number; docId: string; title: string; department: string; score: number }[]
}

function retrieve(
  index: BM25Index,
  byId: Map<string, Doc>,
  question: string,
  params: BM25Params
): Retrieved {
  const hits = search(index, question, TOP_K, params)
  const raw = hits.map((hit) => {
    const doc = byId.get(hit.docId)
    if (!doc) throw new Error(`索引里有一个语料里没有的文档：${hit.docId}`)
    return { ...hit, title: doc.title, department: doc.department }
  })
  // 练习 4：只把分数达到 MIN_SCORE 的命中结果交给生成这一步。
  // 提示：现在这版把前三名无条件塞进上下文。跑一次 pnpm start 看 b08——
  //       语料里根本没有团建预算这回事，三条命中分数都只有 3 分上下，
  //       却照样被当成「资料」喂进去，模板拼出一堆不相干的句子。
  //       补上过滤之后 b08 会变成拒答，而 b09 仍然编——那一条不是检索能挡住的，
  //       它要靠 buildPrompt 里那句「找不到就只回这一句」。
  const passages = hits.map((hit) => ({ doc: byId.get(hit.docId) as Doc, score: hit.score }))
  return { passages, raw }
}

function formatHits(raw: Retrieved['raw']): string {
  if (raw.length === 0) return '  （倒排索引里一个词都没命中）'
  return raw
    .map(
      (h) =>
        `  ${h.rank}. ${h.score.toFixed(2).padStart(6)}  ${h.docId}  ${h.title}（${h.department}）`
    )
    .join('\n')
}

async function runBaseline(
  index: BM25Index,
  byId: Map<string, Doc>,
  params: BM25Params
): Promise<void> {
  const questions = []
  for (const item of BASELINE_QUESTIONS) {
    const { passages, raw } = retrieve(index, byId, item.question, params)
    const text = await answer(item.question, passages)
    console.log(`\n[${item.id}] ${item.question}`)
    console.log(formatHits(raw))
    console.log(`  → ${text.split('\n')[0]}${text.includes('\n') ? ' …' : ''}`)
    questions.push({
      id: item.id,
      question: item.question,
      hits: raw,
      used: passages.map((p) => p.doc.id),
      refused: text.startsWith(REFUSAL),
    })
  }

  const baseline = {
    generatedAt: new Date().toISOString(),
    retriever: 'bm25',
    params: { k1: params.k1, b: params.b, topK: TOP_K, minScore: MIN_SCORE },
    corpus: { docCount: index.docCount, avgTokens: Number(index.avgLength.toFixed(1)) },
    questions,
  }
  writeFileSync('baseline.json', `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(
    `\n已写出 baseline.json（${questions.length} 个问题，参数 k1=${params.k1} b=${params.b}）。`
  )
  console.log('后面每一天的优化都跟这份文件比：命中的文档变了没有、拒答的那题还拒不拒。')
}

async function main(): Promise<void> {
  const docs = loadCorpus()
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  const index = buildIndex(docs.map((doc) => ({ id: doc.id, text: indexableText(doc) })))
  const params = readParams()

  console.log(
    `语料 ${index.docCount} 篇，平均 ${index.avgLength.toFixed(1)} 个词元，` +
      `倒排表 ${index.postings.size} 个词元；k1=${params.k1} b=${params.b} topK=${TOP_K} minScore=${MIN_SCORE}` +
      `${process.env.MOCK === '1' ? '；MOCK=1（生成用模板拼接）' : ''}`
  )

  const question = process.argv.slice(2).join(' ').trim()
  if (!question) {
    await runBaseline(index, byId, params)
    return
  }

  const { passages, raw } = retrieve(index, byId, question, params)
  console.log(`\n问题：${question}`)
  console.log(formatHits(raw))
  console.log(`\n回答：\n${await answer(question, passages)}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
