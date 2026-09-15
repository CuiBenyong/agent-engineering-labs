import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEncoding } from 'js-tiktoken'
import { buildIndex, search } from './bm25'
import type { Chunk, ChunkSet } from './chunkers'

const ENC = getEncoding('cl100k_base')
export const countTokens = (text: string): number => ENC.encode(text).length

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval')

export interface Question {
  id: string
  question: string
  /** 能回答这一问的文档；`none` 类是空数组 */
  answerDocIds: string[]
  /** single：单篇即可答（列出多篇时任意一篇进前 k 就算命中）；multi：必须凑齐全部；none：语料里没有答案 */
  type: 'single' | 'multi' | 'none'
}

export function loadQuestions(): Question[] {
  return JSON.parse(readFileSync(join(EVAL_DIR, 'questions-10.json'), 'utf8')) as Question[]
}

// ---------------------------------------------------------------------------
// 块级统计
// ---------------------------------------------------------------------------

const SENTENCE_END = /[。！？；：」》）】.!?]$/

export interface Stats {
  chunkCount: number
  avgChars: number
  p50Chars: number
  p90Chars: number
  maxChars: number
  avgTokens: number
  /** 末尾没有落在句子边界上的块占比——切法把句子切碎的直接度量 */
  brokenRatio: number
  /** 全部块的 token 总量，等于索引与上下文的存量成本 */
  totalTokens: number
}

export function statsOf(chunks: Chunk[]): Stats {
  const lens = chunks.map((c) => c.text.length).sort((a, b) => a - b)
  const tokens = chunks.map((c) => countTokens(c.text))
  const total = tokens.reduce((s, n) => s + n, 0)
  const broken = chunks.filter((c) => !SENTENCE_END.test(c.text.trim())).length
  const at = (q: number) => lens[Math.min(lens.length - 1, Math.floor(lens.length * q))] ?? 0
  return {
    chunkCount: chunks.length,
    avgChars: Math.round(lens.reduce((s, n) => s + n, 0) / (lens.length || 1)),
    p50Chars: at(0.5),
    p90Chars: at(0.9),
    maxChars: lens[lens.length - 1] ?? 0,
    avgTokens: Math.round(total / (chunks.length || 1)),
    brokenRatio: Number((broken / (chunks.length || 1)).toFixed(3)),
    totalTokens: total,
  }
}

// ---------------------------------------------------------------------------
// 命中率
// ---------------------------------------------------------------------------

/**
 * 对照的尺子是 **token 预算**，不是「取前几块」。
 *
 * 按条数比对切法是不公平的：固定长度 400 字取 5 块塞进去两千多 token，
 * 语义切分平均 200 字取 5 块只塞进去几百 token——赢的那一方只是买了更多货。
 * 生产里能给检索的上下文是一个 token 预算，所以这里也按预算装：
 * 按名次往里放，装满就停。谁能在同样的预算里放进更多有用信息，谁才是真的赢。
 */
export const CONTEXT_BUDGET = 600
/** 打分候选池，装预算之前先取这么多块 */
export const CANDIDATE_K = 20

export interface QuestionResult {
  id: string
  type: Question['type']
  hit: boolean
  /** 预算内装进上下文的块归属的文档，按名次去重 */
  docIds: string[]
  /** 预算内一共装了几块 */
  usedChunks: number
  /** 凑齐答案所需文档在候选池里的名次（多跳取最后一篇；没出现记为候选池长度加一） */
  bestRank: number
  topScore: number
  /** 这一问最终塞进提示词的上下文有多少 token（父子切法按回填后的父块算） */
  contextTokens: number
}

export interface EvalResult {
  name: string
  stats: Stats
  answerable: number
  hits: number
  /** 命中率只在 single 与 multi 上算，`none` 类单独看最高分 */
  hitRate: number
  avgContextTokens: number
  /** 可答问题上答案文档的平均最好名次，越小越好 */
  avgBestRank: number
  /** 预算内平均装进了几块——小块切法能在同样预算里放更多条 */
  avgUsedChunks: number
  noneTopScores: { id: string; topScore: number }[]
  perQuestion: QuestionResult[]
}

export function evaluate(set: ChunkSet, questions: Question[]): EvalResult {
  const index = buildIndex(set.chunks.map((c) => ({ id: c.chunkId, text: c.text })))
  const byChunkId = new Map(set.chunks.map((c) => [c.chunkId, c]))

  const perQuestion: QuestionResult[] = questions.map((q) => {
    const hits = search(index, q.question, CANDIDATE_K)
    const docIds: string[] = []
    let contextTokens = 0
    let usedChunks = 0
    const countedParents = new Set<string>()

    for (const hit of hits) {
      const chunk = byChunkId.get(hit.docId)
      if (!chunk) continue
      // 父子切法命中子块后，真正进上下文的是它的父块，成本要按父块算
      const parent = chunk.parentId ? set.parents.get(chunk.parentId) : undefined
      let cost = 0
      if (parent) {
        if (!countedParents.has(parent.chunkId)) cost = countTokens(parent.text)
      } else {
        cost = countTokens(chunk.text)
      }
      if (contextTokens + cost > CONTEXT_BUDGET) break // 预算装满就停，后面的名次一律进不来
      if (parent) countedParents.add(parent.chunkId)
      contextTokens += cost
      usedChunks += 1
      if (!docIds.includes(chunk.docId)) docIds.push(chunk.docId)
    }

    const hit =
      q.type === 'multi'
        ? q.answerDocIds.every((id) => docIds.includes(id))
        : q.type === 'single'
          ? q.answerDocIds.some((id) => docIds.includes(id))
          : false

    // 名次取「凑齐答案所需的最后一篇文档」第一次出现的位置：
    // 多跳题只捞到其中一篇不算数，这样这个指标才和命中判据说的是同一件事
    const rankOf = (docId: string) => {
      const at = hits.findIndex((h) => byChunkId.get(h.docId)?.docId === docId)
      return at < 0 ? CANDIDATE_K + 1 : at + 1
    }
    const ranks = q.answerDocIds.map(rankOf)
    const bestRank =
      ranks.length === 0
        ? CANDIDATE_K + 1
        : q.type === 'multi'
          ? Math.max(...ranks)
          : Math.min(...ranks)

    return {
      id: q.id,
      type: q.type,
      hit,
      docIds,
      usedChunks,
      bestRank,
      topScore: hits[0]?.score ?? 0,
      contextTokens,
    }
  })

  const answerableResults = perQuestion.filter((r) => r.type !== 'none')
  const hitCount = answerableResults.filter((r) => r.hit).length
  const avgContextTokens = Math.round(
    perQuestion.reduce((s, r) => s + r.contextTokens, 0) / (perQuestion.length || 1)
  )

  return {
    name: set.name,
    stats: statsOf(set.chunks),
    answerable: answerableResults.length,
    hits: hitCount,
    hitRate: Number((hitCount / (answerableResults.length || 1)).toFixed(3)),
    avgContextTokens,
    avgBestRank: Number(
      (
        answerableResults.reduce((s, r) => s + r.bestRank, 0) / (answerableResults.length || 1)
      ).toFixed(2)
    ),
    avgUsedChunks: Number(
      (perQuestion.reduce((s, r) => s + r.usedChunks, 0) / (perQuestion.length || 1)).toFixed(1)
    ),
    noneTopScores: perQuestion
      .filter((r) => r.type === 'none')
      .map((r) => ({ id: r.id, topScore: r.topScore })),
    perQuestion,
  }
}
