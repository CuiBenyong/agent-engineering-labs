import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Department, Tenant } from './corpus.js'
import type { Candidate } from './retrieve.js'
import type { Answered } from './answer.js'

/**
 * 评估面板。
 *
 * D8 造的是一把秤，跑一次看一眼数字就完事；面板要多做三件事，否则三周之后没人会再跑它：
 *
 * 1. **分租户统计**（多租户的第三处落点）。全局平均会把小租户的问题整个平掉——
 *    本天最重要的一个现象就出在这儿。
 * 2. **把失败分类**，而不是只报一个百分比。答不出来分三种病：没捞到、被门槛挡住、
 *    被预算挤掉，各自的修法完全不同（D9 / D10 / D12 反复讲的那件事）。
 * 3. **跟一条存档基线比**，并给出可以让流水线失败的退步判定（D8 的闸门）。
 *
 * 指标实现逐字沿用 D8 的 `metrics.ts`：命中判定 single 任一 / multi 全部、nDCG@10、
 * 600 token 预算。**平均倒数排名不进面板**——D8 已经量到它在这份题集上恒为 1.0000，
 * 是指标饱和不是系统满分，摆在面板上只会让人误判。
 */

const NDCG_K = 10
const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports')
const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval')

// ---------------------------------------------------------------------------
// 题集：D8 定稿的 20 题，本天一个字都不改
// ---------------------------------------------------------------------------

export interface Question {
  id: string
  /** 能回答这一问的文档；`none` 类是空数组 */
  answerDocIds: string[]
  question: string
  type: 'single' | 'multi' | 'none'
}

export function loadGoldenSet(): Question[] {
  const questions = JSON.parse(
    readFileSync(join(EVAL_DIR, 'golden-set.json'), 'utf8')
  ) as Question[]
  const ids = new Set(questions.map((q) => q.id))
  if (ids.size !== questions.length) throw new Error('golden set 里有重复的题号')
  return questions
}

// ---------------------------------------------------------------------------
// 分租户：同一份题集，在不同租户下是不同的题
// ---------------------------------------------------------------------------

/** 一道题在某个租户下的**有效类型**。out-of-scope 是多租户特有的第四类 */
export type EffectiveType = 'single' | 'multi' | 'none' | 'out-of-scope'

/**
 * 同一份 golden set，在两个租户下不是同一份题。
 *
 * 试用工作区只导入了产品文档，那么「灰度分几批放量」在它这里**根本没有答案**——
 * 正确行为是拒答，跟语料里压根没有的那四道题是同一类。
 * 判据分类型：`single` 的答案文档只要有一篇在订阅范围里就还答得出来；
 * `multi` 必须全部在范围内，少一篇就答不出来。
 */
export function projectQuestion(
  q: Question,
  tenant: Tenant,
  deptOf: Map<string, Department>
): { type: EffectiveType; answerDocIds: string[] } {
  if (q.type === 'none') return { type: 'none', answerDocIds: [] }
  const inScope = q.answerDocIds.filter((id) => {
    const dept = deptOf.get(id)
    return dept !== undefined && tenant.subscribes.includes(dept)
  })
  if (q.type === 'multi') {
    return inScope.length === q.answerDocIds.length
      ? { type: 'multi', answerDocIds: inScope }
      : { type: 'out-of-scope', answerDocIds: [] }
  }
  return inScope.length > 0
    ? { type: 'single', answerDocIds: inScope }
    : { type: 'out-of-scope', answerDocIds: [] }
}

// ---------------------------------------------------------------------------
// 一道题的一次记录
// ---------------------------------------------------------------------------

/** 失败模式速查表的机器版。每一类对应一条不同的排查路径，见正文 */
export type Failure =
  /** 答案文档一次都没进候选池：检索侧的债，放宽门槛没用，要多跳或换索引结构 */
  | 'not-retrieved'
  /** 进了候选池但没有一块过门槛：门槛的债，放宽或降级重判 */
  | 'gated-out'
  /** 过了门槛但没装进 600 token：预算的债，提预算或把块切小 */
  | 'budget-squeezed'
  /** 该拒答却答了：拒答闸门的债 */
  | 'over-answered'
  /** 答了，但有句子的引用被校验拦下：生成侧的债 */
  | 'citation-misaligned'

export interface Record14 {
  id: string
  tenantId: string
  type: EffectiveType
  answerDocIds: string[]
  rankedDocIds: string[]
  contextDocIds: string[]
  contextTokens: number
  relevantChunkCount: number
  admitted: boolean
  hit: boolean
  ndcg: number
  status: Answered['status']
  refusal?: string
  rejectedCitations: number
  failure?: Failure
}

export function makeRecord(
  q: Question,
  tenant: Tenant,
  projected: { type: EffectiveType; answerDocIds: string[] },
  candidates: Candidate[],
  result: Answered,
  relevantChunkCount: number
): Record14 {
  const rankedDocIds = candidates.map((c) => c.chunk.docId)
  const contextDocIds: string[] = []
  for (const b of result.blocks) {
    if (!contextDocIds.includes(b.candidate.chunk.docId))
      contextDocIds.push(b.candidate.chunk.docId)
  }
  const answerDocIds = projected.answerDocIds
  const hit =
    projected.type === 'multi'
      ? answerDocIds.length > 0 && answerDocIds.every((id) => contextDocIds.includes(id))
      : projected.type === 'single'
        ? answerDocIds.some((id) => contextDocIds.includes(id))
        : false

  const gains: number[] = rankedDocIds
    .slice(0, NDCG_K)
    .map((id) => (answerDocIds.includes(id) ? 1 : 0))
  const dcg = gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
  let idcg = 0
  for (let i = 0; i < Math.min(relevantChunkCount, NDCG_K); i += 1) idcg += 1 / Math.log2(i + 2)
  const ndcg = idcg === 0 || answerDocIds.length === 0 ? 0 : dcg / idcg

  return {
    id: q.id,
    tenantId: tenant.id,
    type: projected.type,
    answerDocIds,
    rankedDocIds,
    contextDocIds,
    contextTokens: result.contextTokens,
    relevantChunkCount,
    admitted: candidates.some((c) => c.admitted),
    hit,
    ndcg,
    status: result.status,
    refusal: result.reason,
    rejectedCitations: result.rejected.length,
    failure: classify(
      projected.type,
      hit,
      rankedDocIds,
      contextDocIds,
      answerDocIds,
      candidates,
      result
    ),
  }
}

/**
 * 把一次失败归到某一类。**顺序就是排查顺序**：从最上游查起，
 * 因为上游的错会被下游放大（D1 那条「排查从右往左看、修复从左往右修」的可执行版本）。
 */
function classify(
  type: EffectiveType,
  hit: boolean,
  rankedDocIds: string[],
  contextDocIds: string[],
  answerDocIds: string[],
  candidates: Candidate[],
  result: Answered
): Failure | undefined {
  if (type === 'none' || type === 'out-of-scope') {
    return result.status === 'answered' ? 'over-answered' : undefined
  }
  if (!hit) {
    // 诊断的对象是**缺的那几篇**，不是「有没有捞到任何一篇」。
    // 多跳题少一篇就算没中，而少的那一篇可能病在完全不同的一层——
    // 用 some() 去判会把 q06 那种「第一篇稳稳第一、第二篇一次都没出现」误判成预算问题。
    const missing = answerDocIds.filter((id) => !contextDocIds.includes(id))
    if (missing.some((id) => !rankedDocIds.includes(id))) return 'not-retrieved'
    const admittedDocs = candidates.filter((c) => c.admitted).map((c) => c.chunk.docId)
    if (missing.some((id) => !admittedDocs.includes(id))) return 'gated-out'
    return 'budget-squeezed'
  }
  return result.rejected.length > 0 ? 'citation-misaligned' : undefined
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export interface TenantMetrics {
  tenantId: string
  chunks: number
  answerable: number
  shouldRefuse: number
  singleCount: number
  multiCount: number
  recall: number
  recallSingle: number
  recallMulti: number
  ndcg: number
  /** 该拒答的题里真的拒答了的比例。它和召回率是一对，只看一个会被骗（D8） */
  abstainRate: number
  avgContextTokens: number
  citationRejects: number
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4))

/**
 * **练习 4 挖的就是这个函数。** 分组键必须是 `tenantId`；
 * 把全部记录混在一起求平均，小租户的问题会被大租户的数字整个平掉——
 * 本天自测第五项验的就是这件事。
 */
export function aggregateByTenant(
  records: Record14[],
  chunksPerTenant: Map<string, number>
): TenantMetrics[] {
  const groups = new Map<string, Record14[]>()
  for (const r of records) {
    const list = groups.get(r.tenantId) ?? []
    list.push(r)
    groups.set(r.tenantId, list)
  }
  return [...groups].map(([tenantId, rows]) => {
    const answerable = rows.filter((r) => r.type === 'single' || r.type === 'multi')
    const shouldRefuse = rows.filter((r) => r.type === 'none' || r.type === 'out-of-scope')
    return {
      tenantId,
      chunks: chunksPerTenant.get(tenantId) ?? 0,
      answerable: answerable.length,
      shouldRefuse: shouldRefuse.length,
      singleCount: answerable.filter((r) => r.type === 'single').length,
      multiCount: answerable.filter((r) => r.type === 'multi').length,
      recall: mean(answerable.map((r) => (r.hit ? 1 : 0))),
      recallSingle: mean(answerable.filter((r) => r.type === 'single').map((r) => (r.hit ? 1 : 0))),
      recallMulti: mean(answerable.filter((r) => r.type === 'multi').map((r) => (r.hit ? 1 : 0))),
      ndcg: mean(answerable.map((r) => r.ndcg)),
      abstainRate: mean(shouldRefuse.map((r) => (r.status === 'refused' ? 1 : 0))),
      avgContextTokens: Number(
        (rows.reduce((s, r) => s + r.contextTokens, 0) / (rows.length || 1)).toFixed(1)
      ),
      citationRejects: rows.reduce((s, r) => s + r.rejectedCitations, 0),
    }
  })
}

/** 全局平均：面板上必须和分租户那几行并排摆着，否则它就是个误导 */
export function aggregateGlobal(records: Record14[]): Omit<TenantMetrics, 'tenantId' | 'chunks'> {
  const [all] = aggregateByTenant(
    records.map((r) => ({ ...r, tenantId: 'ALL' })),
    new Map()
  )
  const { tenantId: _t, chunks: _c, ...rest } = all
  return rest
}

export function failureCounts(records: Record14[]): Array<{ failure: Failure; ids: string[] }> {
  const order: Failure[] = [
    'not-retrieved',
    'gated-out',
    'budget-squeezed',
    'over-answered',
    'citation-misaligned',
  ]
  return order
    .map((failure) => ({
      failure,
      ids: records.filter((r) => r.failure === failure).map((r) => `${r.tenantId}/${r.id}`),
    }))
    .filter((row) => row.ids.length > 0)
}

// ---------------------------------------------------------------------------
// 三笔账：指标、延迟、钱
// ---------------------------------------------------------------------------

const envNum = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isFinite(n) ? n : fallback
}

/**
 * ⚠️ 全部是**占位值，不是任何厂商的报价**。单价会变，而读者无从知道正文里的数字
 * 什么时候过期。这份账里唯一由实测撑着的是 **token 数与调用次数**；
 * 金额与占比随单价而变，所以引用结论时永远要连着单价一起说。
 *
 * 同理，`MOCK=1` 下没有任何网络往返，**延迟一律走建模值**（占位），
 * 实测毫秒数只说明「代码本身有多重」。
 */
export const PRICES = {
  embedPerMTok: envNum('PRICE_EMBED_IN', 0.02),
  rerankPerKSearch: envNum('PRICE_RERANK_PER_KSEARCH', 2.0),
  genInPerMTok: envNum('PRICE_GEN_IN', 3),
  genOutPerMTok: envNum('PRICE_GEN_OUT', 15),
}
export const LATENCY_MODEL = {
  embedMs: envNum('LAT_EMBED_MS', 120),
  rerankMs: envNum('LAT_RERANK_MS', 180),
  generateMs: envNum('LAT_GEN_MS', 900),
}

export interface Ledger {
  embedTokensPerQ: number
  rerankCallsPerQ: number
  rerankInputTokensPerQ: number
  genInTokensPerQ: number
  genOutTokensPerQ: number
  /** 每千次提问的费用（占位单价） */
  usdPerKQueries: number
  /** 建模的每问网络往返毫秒（占位） */
  modeledMs: number
}

/**
 * **练习 5 挖的就是这个函数。** 只有一处容易错：单价的单位是「每百万 token」，
 * 所以要除以 1e6，不是 1e3；而重排按**检索次数**计价，不按 token——
 * 这解释了为什么「多送几条给它排」几乎不加钱，真正贵的是提问次数本身（D9）。
 */
export function ledger(input: {
  questions: number
  embedTokens: number
  rerankCalls: number
  rerankInputTokens: number
  genIn: number
  genOut: number
}): Ledger {
  const n = input.questions || 1
  const embedTokensPerQ = input.embedTokens / n
  const rerankCallsPerQ = input.rerankCalls / n
  const genInTokensPerQ = input.genIn / n
  const genOutTokensPerQ = input.genOut / n
  const usdPerKQueries =
    (embedTokensPerQ / 1_000_000) * PRICES.embedPerMTok * 1000 +
    rerankCallsPerQ * PRICES.rerankPerKSearch +
    (genInTokensPerQ / 1_000_000) * PRICES.genInPerMTok * 1000 +
    (genOutTokensPerQ / 1_000_000) * PRICES.genOutPerMTok * 1000
  return {
    embedTokensPerQ: Number(embedTokensPerQ.toFixed(1)),
    rerankCallsPerQ: Number(rerankCallsPerQ.toFixed(2)),
    rerankInputTokensPerQ: Number((input.rerankInputTokens / n).toFixed(1)),
    genInTokensPerQ: Number(genInTokensPerQ.toFixed(1)),
    genOutTokensPerQ: Number(genOutTokensPerQ.toFixed(1)),
    usdPerKQueries: Number(usdPerKQueries.toFixed(4)),
    modeledMs: Number(
      (
        LATENCY_MODEL.embedMs +
        rerankCallsPerQ * LATENCY_MODEL.rerankMs +
        LATENCY_MODEL.generateMs
      ).toFixed(1)
    ),
  }
}

// ---------------------------------------------------------------------------
// 存档、对比、闸门
// ---------------------------------------------------------------------------

export interface Panel {
  generatedAt: string
  backend: string
  reranker: string
  store: string
  global: Omit<TenantMetrics, 'tenantId' | 'chunks'>
  tenants: TenantMetrics[]
  failures: Array<{ failure: Failure; ids: string[] }>
  ledger: Ledger
}

/** 守五项，各守一层。少一项就有一类退步能溜过去（D8 的闸门，容差同样是 0.01） */
const GATED: Array<[string, (m: Panel) => number]> = [
  ['召回率', (p) => p.global.recall],
  ['多跳召回率', (p) => p.global.recallMulti],
  ['nDCG@10', (p) => p.global.ndcg],
  ['拒答率', (p) => p.global.abstainRate],
  ['最小租户召回率', (p) => Math.min(...p.tenants.map((t) => t.recall))],
]

export function gate(
  current: Panel,
  baseline: Panel,
  tolerance = 0.01
): { passed: boolean; regressions: Array<{ name: string; delta: number }> } {
  const regressions = GATED.map(([name, pick]) => ({
    name,
    delta: Number((pick(current) - pick(baseline)).toFixed(4)),
  })).filter((r) => r.delta < -tolerance)
  return { passed: regressions.length === 0, regressions }
}

export function loadBaseline(): Panel | null {
  const file = join(EVAL_DIR, 'baseline-panel.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Panel
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

/** 面板的可读版。它要能贴进作品集的项目说明里，所以是 Markdown 而不是一堆 console.log */
export function renderMarkdown(panel: Panel, tenants: Tenant[]): string {
  const nameOf = new Map(tenants.map((t) => [t.id, t.name]))
  const lines: string[] = [
    '# 多租户知识库问答 · 评估面板',
    '',
    `- 生成时间：${panel.generatedAt}`,
    `- embedding 后端：${panel.backend}｜重排后端：${panel.reranker}｜索引：${panel.store}`,
    '',
    '## 一、分租户指标（面板的主表）',
    '',
    '| 工作区 | 索引块数 | 可答题 | 应拒答 | 召回率 | single | multi | nDCG@10 | 拒答率 | 平均上下文 token |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  // 一个空集合的平均值是 0，但「0.0%」和「这一档没有题」是两件完全不同的事。
  // 把它们印成同一个字符串，是评估报告里最常见、也最伤人的一种谎。
  const orDash = (value: number, count: number): string => (count === 0 ? '—' : pct(value))
  for (const t of panel.tenants) {
    lines.push(
      `| ${nameOf.get(t.tenantId) ?? t.tenantId} | ${t.chunks} | ${t.answerable} | ${t.shouldRefuse} | ${pct(
        t.recall
      )} | ${orDash(t.recallSingle, t.singleCount)} | ${orDash(t.recallMulti, t.multiCount)} | ${t.ndcg.toFixed(
        4
      )} | ${pct(t.abstainRate)} | ${t.avgContextTokens} |`
    )
  }
  lines.push(
    `| **全局平均（会骗人的那一行）** | — | ${panel.global.answerable} | ${panel.global.shouldRefuse} | ${pct(
      panel.global.recall
    )} | ${orDash(panel.global.recallSingle, panel.global.singleCount)} | ${orDash(
      panel.global.recallMulti,
      panel.global.multiCount
    )} | ${panel.global.ndcg.toFixed(4)} | ${pct(panel.global.abstainRate)} | ${panel.global.avgContextTokens} |`,
    '',
    '## 二、失败模式（按排查顺序，从最上游排起）',
    ''
  )
  const label: Record<Failure, string> = {
    'not-retrieved': '答案文档没进候选池 → 先查分词与索引，再考虑多跳（D12）',
    'gated-out': '进了候选池但没过门槛 → 查门槛与降级放宽（D7 / D12）',
    'budget-squeezed': '过了门槛但没装进预算 → 查上下文预算与块大小（D4 / D10）',
    'over-answered': '该拒答却答了 → 查拒答闸门与租户范围（D6）',
    'citation-misaligned': '引用与句子对不上 → 查引用校验与上下文组装（D6）',
  }
  if (panel.failures.length === 0) lines.push('（本次没有失败样本）')
  for (const row of panel.failures) {
    lines.push(`- **${label[row.failure]}**：${row.ids.length} 题 —— ${row.ids.join('、')}`)
  }
  lines.push(
    '',
    '## 三、三笔账（金额是占位单价，token 数是实测）',
    '',
    `- 每问查询向量化 ${panel.ledger.embedTokensPerQ} token；重排 ${panel.ledger.rerankCallsPerQ} 次 / ${panel.ledger.rerankInputTokensPerQ} token`,
    `- 每问生成 ${panel.ledger.genInTokensPerQ} in / ${panel.ledger.genOutTokensPerQ} out token`,
    `- 每千次提问约 $${panel.ledger.usdPerKQueries}（占位单价，改单价后占比会翻转）`,
    `- 建模每问网络往返 ${panel.ledger.modeledMs} ms（占位；MOCK 下不走网络，实测毫秒不代表线上）`,
    ''
  )
  return lines.join('\n')
}

export function writePanel(panel: Panel, tenants: Tenant[]): { json: string; md: string } {
  mkdirSync(PANEL_DIR, { recursive: true })
  const json = join(PANEL_DIR, 'panel.json')
  const md = join(PANEL_DIR, 'panel.md')
  writeFileSync(json, `${JSON.stringify(panel, null, 2)}\n`)
  writeFileSync(md, renderMarkdown(panel, tenants))
  return { json, md }
}
