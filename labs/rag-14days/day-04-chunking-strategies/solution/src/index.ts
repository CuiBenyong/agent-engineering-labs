import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCorpus } from './corpus'
import {
  chunkFixed,
  chunkParentChild,
  chunkRecursive,
  chunkSemantic,
  chunkStructure,
  type Chunker,
} from './chunkers'
import { withContextualHeaders } from './header'
import { CONTEXT_BUDGET, evaluate, loadQuestions, type EvalResult } from './evaluate'

const HERE = dirname(fileURLToPath(import.meta.url))

const STRATEGIES: { label: string; chunker: Chunker }[] = [
  { label: '固定长度 400/80', chunker: chunkFixed() },
  { label: '递归 400/80', chunker: chunkRecursive() },
  { label: '按结构 (上限 700)', chunker: chunkStructure() },
  { label: '父子 200/40 → 节', chunker: chunkParentChild() },
  { label: '语义 (25%分位)', chunker: chunkSemantic() },
]

function pad(text: string, width: number): string {
  // 中文在等宽终端里占两格，按显示宽度补空格，表格才不会歪
  const shown = [...text].reduce((w, ch) => w + (/[一-鿿（）：]/.test(ch) ? 2 : 1), 0)
  return text + ' '.repeat(Math.max(0, width - shown))
}

function printTable(rows: (readonly string[])[]): void {
  const widths = rows[0].map((_, col) =>
    Math.max(
      ...rows.map((r) => [...r[col]].reduce((w, ch) => w + (/[一-鿿（）：]/.test(ch) ? 2 : 1), 0))
    )
  )
  rows.forEach((row, i) => {
    console.log(row.map((cell, col) => pad(cell, widths[col])).join('  '))
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  })
}

async function main(): Promise<void> {
  const docs = loadCorpus()
  const questions = loadQuestions()
  const answerable = questions.filter((q) => q.type !== 'none').length

  console.log(
    `语料 ${docs.length} 篇，问题 ${questions.length} 题（可答 ${answerable} 题，无答案 ${questions.length - answerable} 题），上下文预算 ${CONTEXT_BUDGET} token\n`
  )

  const results: EvalResult[] = []
  for (const { label, chunker } of STRATEGIES) {
    const set = await chunker(docs)
    const result = evaluate(set, questions)
    results.push({ ...result, name: label })
  }

  console.log('一、五种切法的块级统计')
  printTable([
    ['切法', '块数', '平均字数', 'P50', 'P90', '最长', '平均token', '切碎率', '总token'],
    ...results.map(
      (r) =>
        [
          r.name,
          String(r.stats.chunkCount),
          String(r.stats.avgChars),
          String(r.stats.p50Chars),
          String(r.stats.p90Chars),
          String(r.stats.maxChars),
          String(r.stats.avgTokens),
          `${(r.stats.brokenRatio * 100).toFixed(1)}%`,
          String(r.stats.totalTokens),
        ] as const
    ),
  ])

  console.log(
    `\n二、同一批问题下的命中率（在 ${CONTEXT_BUDGET} token 的同一预算下装块；多跳题要求全部答案文档都进）`
  )
  printTable([
    [
      '切法',
      '命中',
      '命中率',
      '平均装入块数',
      '平均上下文token',
      '答案文档平均名次',
      'q06多跳',
      'q07多跳',
      'q09无答案最高分',
      'q10无答案最高分',
    ],
    ...results.map((r) => {
      const q = (id: string) => r.perQuestion.find((x) => x.id === id)
      return [
        r.name,
        `${r.hits}/${r.answerable}`,
        `${(r.hitRate * 100).toFixed(0)}%`,
        String(r.avgUsedChunks),
        String(r.avgContextTokens),
        String(r.avgBestRank),
        q('q06')?.hit ? '命中' : '未中',
        q('q07')?.hit ? '命中' : '未中',
        (q('q09')?.topScore ?? 0).toFixed(2),
        (q('q10')?.topScore ?? 0).toFixed(2),
      ] as const
    }),
  ])

  // 给固定长度这一档加上下文块头，看命中率与 token 成本各变了多少
  const base = await chunkFixed()(docs)
  const baseResult = evaluate(base, questions)
  const headed = await withContextualHeaders(docs, base)
  const headedResult = evaluate(headed, questions)

  console.log('\n三、给「固定长度」加上下文块头之后')
  printTable([
    ['版本', '命中', '命中率', '答案文档平均名次', '索引总token', 'token增幅'],
    [
      '固定长度',
      `${baseResult.hits}/${baseResult.answerable}`,
      `${(baseResult.hitRate * 100).toFixed(0)}%`,
      String(baseResult.avgBestRank),
      String(baseResult.stats.totalTokens),
      '-',
    ],
    [
      '固定长度+块头',
      `${headedResult.hits}/${headedResult.answerable}`,
      `${(headedResult.hitRate * 100).toFixed(0)}%`,
      String(headedResult.avgBestRank),
      String(headedResult.stats.totalTokens),
      `+${(((headedResult.stats.totalTokens - baseResult.stats.totalTokens) / baseResult.stats.totalTokens) * 100).toFixed(1)}%`,
    ],
  ])

  const report = {
    generatedAt: new Date().toISOString(),
    mock: process.env.MOCK === '1',
    contextBudget: CONTEXT_BUDGET,
    corpus: { docCount: docs.length },
    strategies: [...results, { ...headedResult, name: '固定长度+块头' }],
  }
  const out = join(HERE, '..', 'chunking-report.json')
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n对照表已写入 ${out}`)
  console.log('结论要连着前提一起写：换一份语料、换一批问题，下面这些数字都会变。')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
