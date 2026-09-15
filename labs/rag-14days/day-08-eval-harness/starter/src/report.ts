import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChunks, WEEK1_CHUNKING } from './corpus'
import { coverage, loadGoldenSet, loadHumanLabels, type Question } from './goldenset'
import {
  aggregate,
  CANDIDATE_K,
  CONTEXT_BUDGET,
  isHit,
  ndcgAt,
  NDCG_K,
  reciprocalRank,
  trace,
  type RetrievalMetrics,
  type RetrievalTrace,
} from './metrics'
import {
  agreementRate,
  aggregateGeneration,
  answerFor,
  judgeAnswer,
  REFUSAL,
  runProbes,
  type Agreement,
  type GenerationMetrics,
  type JudgeScore,
  type Probe,
} from './judge'
import { createWeek1Retriever, WEEK1_RETRIEVAL } from './retrieve'

/** lab 根目录：报告写在这里，基线也从这里读 */
const LAB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface PerQuestion {
  id: string
  type: Question['type']
  hit: boolean
  reciprocalRank: number
  ndcg: number
  contextDocIds: string[]
  contextTokens: number
  admitted: boolean
  answer: string
  faithfulness: number
  answerRelevancy: number
}

export interface Report {
  generatedAt: string
  config: {
    corpusDocs: number
    chunks: number
    chunking: typeof WEEK1_CHUNKING
    retrieval: typeof WEEK1_RETRIEVAL
    contextBudget: number
    candidateK: number
    ndcgK: number
    embedBackend: string
    judge: string
  }
  goldenSet: { total: number; coverage: Record<Question['type'], number> }
  retrieval: RetrievalMetrics
  generation: GenerationMetrics
  probes: Probe[]
  agreement: Agreement
  perQuestion: PerQuestion[]
}

/** 跑一遍完整评估。这就是「一条命令」背后的全部内容 */
export async function runEvaluation(): Promise<Report> {
  const chunks = loadChunks()
  const questions = loadGoldenSet()
  const retriever = await createWeek1Retriever(chunks)

  const traces: RetrievalTrace[] = []
  const scores: JudgeScore[] = []
  const answers = new Map<string, string>()
  const perQuestion: PerQuestion[] = []

  for (const q of questions) {
    const t = await trace(retriever, q, chunks)
    const answer = answerFor(q.question, t.contextChunks)
    const score = await judgeAnswer(q, answer, t.contextChunks)
    traces.push(t)
    scores.push(score)
    answers.set(q.id, answer)
    perQuestion.push({
      id: q.id,
      type: q.type,
      hit: isHit(t),
      reciprocalRank: Number(reciprocalRank(t).toFixed(4)),
      ndcg: Number(ndcgAt(t).toFixed(4)),
      contextDocIds: t.contextDocIds,
      contextTokens: t.contextTokens,
      admitted: t.admitted,
      answer,
      faithfulness: score.faithfulness,
      answerRelevancy: score.answerRelevancy,
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    config: {
      corpusDocs: new Set(chunks.map((c) => c.docId)).size,
      chunks: chunks.length,
      chunking: WEEK1_CHUNKING,
      retrieval: WEEK1_RETRIEVAL,
      contextBudget: CONTEXT_BUDGET,
      candidateK: CANDIDATE_K,
      ndcgK: NDCG_K,
      embedBackend: retriever.backendName,
      judge: scores[0]?.judge ?? 'unknown',
    },
    goldenSet: { total: questions.length, coverage: coverage(questions) },
    retrieval: aggregate(traces),
    generation: aggregateGeneration(scores, answers, questions),
    probes: runProbes(),
    agreement: agreementRate(scores, loadHumanLabels()),
    perQuestion,
  }
}

// ---------------------------------------------------------------------------
// 报告文件与回归闸门
// ---------------------------------------------------------------------------

export function writeReport(report: Report): { json: string; md: string } {
  const dir = join(LAB_ROOT, 'reports')
  mkdirSync(dir, { recursive: true })
  const json = join(dir, 'latest.json')
  const md = join(dir, 'latest.md')
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(md, renderMarkdown(report))
  return { json, md }
}

function renderMarkdown(r: Report): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
  const lines = [
    '# 第一周系统基线报告',
    '',
    `- 生成时间：${r.generatedAt}`,
    `- 语料：${r.config.corpusDocs} 篇 / ${r.config.chunks} 块，切块 ${r.config.chunking.maxChars} 字上限`,
    `- 检索：两路各取 ${r.config.retrieval.perRouteTopK}，加权 ${r.config.retrieval.weights.bm25} : ${r.config.retrieval.weights.vector}，上下文预算 ${r.config.contextBudget} token`,
    `- 向量后端：${r.config.embedBackend}；裁判：${r.config.judge}`,
    `- 题集：${r.goldenSet.total} 题（single ${r.goldenSet.coverage.single} / multi ${r.goldenSet.coverage.multi} / none ${r.goldenSet.coverage.none}）`,
    '',
    '## 检索侧',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 召回率（全部可答题） | ${pct(r.retrieval.recall)} |`,
    `| 召回率（single） | ${pct(r.retrieval.recallSingle)} |`,
    `| 召回率（multi） | ${pct(r.retrieval.recallMulti)} |`,
    `| 平均倒数排名 | ${r.retrieval.mrr.toFixed(4)} |`,
    `| 归一化折损累计增益@${r.config.ndcgK} | ${r.retrieval.ndcg.toFixed(4)} |`,
    `| 无答案题拒答率 | ${pct(r.retrieval.abstainRate)} |`,
    `| 平均上下文 token | ${r.retrieval.avgContextTokens} |`,
    '',
    '## 生成侧',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 忠实度 | ${r.generation.faithfulness.toFixed(4)} |`,
    `| 答案相关性 | ${r.generation.answerRelevancy.toFixed(4)} |`,
    `| 无答案题真的拒答 | ${pct(r.generation.refusalOnNone)} |`,
    `| 人工抽检一致率 | ${pct(r.agreement.rate)}（${r.agreement.agreed}/${r.agreement.checked}） |`,
    '',
    '## 裁判探针',
    '',
    '| 探针 | 忠实度 | 结果 |',
    '| --- | --- | --- |',
    ...r.probes.map(
      (p) =>
        `| ${p.name} | ${p.faithfulness.toFixed(2)} | ${p.passed ? '通过' : p.blindSpot ? '未通过（已知盲区）' : '未通过'} |`
    ),
    '',
    '## 逐题',
    '',
    '| 题号 | 类型 | 命中 | 倒数排名 | nDCG | 上下文 token | 忠实度 | 相关性 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.perQuestion.map(
      (q) =>
        `| ${q.id} | ${q.type} | ${q.type === 'none' ? (q.admitted ? '误答' : '正确拒答') : q.hit ? '✅' : '❌'} | ${q.reciprocalRank.toFixed(3)} | ${q.ndcg.toFixed(3)} | ${q.contextTokens} | ${q.faithfulness.toFixed(2)} | ${q.answerRelevancy.toFixed(2)} |`
    ),
    '',
  ]
  return `${lines.join('\n')}\n`
}

export function loadBaseline(): Report | null {
  try {
    return JSON.parse(
      readFileSync(join(LAB_ROOT, 'eval', 'baseline-report.json'), 'utf8')
    ) as Report
  } catch {
    return null
  }
}

export interface GateResult {
  passed: boolean
  regressions: Array<{ metric: string; baseline: number; current: number; delta: number }>
}

/** 允许的噪声。同一份数据、同一份配置本该逐位相同，留一点余量是给换 embedding 后端用的 */
export const GATE_TOLERANCE = 0.01

/**
 * 回归闸门：把本次报告和上一版基线逐项比，任何一项跌超过容差就拦住。
 *
 * 为什么盯的是这五项而不是全部：它们各自守住一层——
 * 召回率守「找得到」，倒数排名与 nDCG 守「排得好」，忠实度守「不乱说」，
 * 拒答率守「没有答案时闭嘴」。少一项，就有一类退步能悄悄溜过去。
 */
export function gate(current: Report, baseline: Report | null): GateResult {
  if (!baseline) return { passed: true, regressions: [] }
  // 练习 5：把回归闸门接上。下面的 pairs 已经列好了要盯的五项，
  // 你要做的是：算出每一项的 delta（当前 - 基线），过滤出 delta 小于 -GATE_TOLERANCE 的，
  // 有一条就 passed: false。现在它无条件放行，所以「把召回率调低 15 个点」那条验收是 ❌。
  const _pairs: Array<[string, number, number]> = [
    ['召回率', baseline.retrieval.recall, current.retrieval.recall],
    ['平均倒数排名', baseline.retrieval.mrr, current.retrieval.mrr],
    ['归一化折损累计增益', baseline.retrieval.ndcg, current.retrieval.ndcg],
    ['无答案题拒答率', baseline.retrieval.abstainRate, current.retrieval.abstainRate],
    ['忠实度', baseline.generation.faithfulness, current.generation.faithfulness],
  ]
  void _pairs
  void current
  return { passed: true, regressions: [] }
}

export { REFUSAL }
