import type { Chunk } from './corpus.js'
import { createEmbedBackend, type EmbedBackend } from './embed.js'
import { inScope, type Scope, type VectorStore } from './store.js'

/**
 * 检索层：关键词一路 + 向量一路 + 倒数排名融合 + 重排 + 准入门槛。
 *
 * **本文件是 D9 的 `retrieve.ts` / `fuse.ts` / `rerank.ts` 三个文件合起来复制过来的，
 * 参数一个都没改**——BM25 的 k1 与 b 来自 D1，每路取 50、融合留 20 来自卡片 3.7ter，
 * 门槛来自 D7 的 `rag.config.json`。改了任何一个，本天的数字就跟 D9 / D12 不可比。
 *
 * 本天真正新增的只有一件事：**每一路都吃一个 `Scope`**（租户 + 部门）。
 * 这是多租户的第二处落点：**过滤发生在打分之前**，不是打完分再筛。
 */

/** 逐字沿用 D1/D7/D8/D9 的参数与门槛 */
export const RETRIEVAL = {
  bm25: { k1: 1.2, b: 0.75 },
  perRouteTopK: Number(process.env.PER_ROUTE_K ?? 50),
  /** 门槛判的是**每一路的原始分**，不是融合分（D7 那条坑：融合分是按本次最高分归一化的） */
  gates: { bm25MinScore: 6, vectorMinCosine: 0.2 },
}

/** k = 60 是 RRF 原论文的常用取值，全课统一 */
export const RRF_K = 60
/** 融合后留前 20 条交给重排——不是全库重排，成本理由见 D9 */
export const FUSE_KEEP = 20

export interface Scored {
  chunkId: string
  score: number
}

export interface Fused {
  id: string
  score: number
}

/** 中英混合分词：中文二元组、英文按词。与 D1 逐字一致 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const segments = text.toLowerCase().match(/[一-鿿]+|[a-z0-9]+/g) ?? []
  for (const seg of segments) {
    if (/^[一-鿿]+$/.test(seg)) {
      if (seg.length === 1) {
        tokens.push(seg)
        continue
      }
      for (let i = 0; i + 1 < seg.length; i += 1) tokens.push(seg.slice(i, i + 2))
    } else if (seg.length > 1) {
      tokens.push(seg)
    }
  }
  return tokens
}

/**
 * 倒数排名融合。规格来自卡片 3.7ter，**逐字照抄 D9**：
 * 只看名次不看分数（两路的分数量纲不可比），同分按 id 兜底排序（否则跨天名次会飘）。
 */
export function rrfFuse(rankings: string[][], k: number = RRF_K): Fused[] {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      // 名次从 1 起算
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)) // 同分按 id 排，保证可复现
}

// ---------------------------------------------------------------------------
// 关键词一路
// ---------------------------------------------------------------------------

interface Bm25Index {
  postings: Map<string, Map<string, number>>
  lengths: Map<string, number>
  docCount: number
  avgLength: number
}

/**
 * 每个租户一张倒排索引。为什么不共用一张：BM25 的逆文档频率是**语料统计量**，
 * 共用一张的话 A 租户导入一万篇文档就会改变 B 租户看到的词权重——
 * 那正是 D5 说的「A 租户挤掉 B 租户」在关键词一路上的形态。
 *
 * 但索引是按**租户**建的，不按部门建：同一个租户内部，词权重不该因为
 * 「这次是客服在问」而变。权限收窄发生在候选过滤那一步，不在统计量这一层。
 */
function buildBm25(chunks: Chunk[]): Bm25Index {
  const postings = new Map<string, Map<string, number>>()
  const lengths = new Map<string, number>()
  for (const chunk of chunks) {
    const terms = tokenize(`${chunk.headingPath.join(' ')} ${chunk.text}`)
    lengths.set(chunk.chunkId, terms.length)
    for (const term of terms) {
      let byChunk = postings.get(term)
      if (!byChunk) {
        byChunk = new Map<string, number>()
        postings.set(term, byChunk)
      }
      byChunk.set(chunk.chunkId, (byChunk.get(chunk.chunkId) ?? 0) + 1)
    }
  }
  const total = [...lengths.values()].reduce((sum, n) => sum + n, 0)
  return {
    postings,
    lengths,
    docCount: chunks.length,
    avgLength: chunks.length ? total / chunks.length : 0,
  }
}

function bm25Search(
  index: Bm25Index,
  byId: Map<string, Chunk>,
  query: string,
  scope: Scope,
  topK: number
): Scored[] {
  const { k1, b } = RETRIEVAL.bm25
  const terms = tokenize(query)
  const candidates = new Set<string>()
  for (const term of terms) {
    for (const id of index.postings.get(term)?.keys() ?? []) {
      const chunk = byId.get(id)
      // 范围谓词在**打分之前**生效：不在范围里的块一次都没参与比较
      if (chunk && inScope(chunk, scope)) candidates.add(id)
    }
  }
  return [...candidates]
    .map((chunkId) => {
      const len = index.lengths.get(chunkId) ?? 0
      const norm = 1 - b + (b * len) / (index.avgLength || 1)
      let score = 0
      for (const term of terms) {
        const f = index.postings.get(term)?.get(chunkId) ?? 0
        if (f === 0) continue
        const n = index.postings.get(term)?.size ?? 0
        const idf = Math.log(1 + (index.docCount - n + 0.5) / (n + 0.5))
        score += (idf * (f * (k1 + 1))) / (f + k1 * norm)
      }
      return { chunkId, score }
    })
    .sort((a, b2) => b2.score - a.score || a.chunkId.localeCompare(b2.chunkId))
    .slice(0, topK)
}

// ---------------------------------------------------------------------------
// 重排
// ---------------------------------------------------------------------------

export type Reranker = (
  query: string,
  docs: Array<{ id: string; text: string }>
) => Promise<Array<{ id: string; score: number }>>

/**
 * `MOCK=1` 下的确定性替身，口径照抄 D9：按「查询词元与文档词元的加权重合度」打分，
 * 权重来自候选集内的文档频率。可复现、不走网络。
 * **它不代表真实交叉编码器的效果**，只验证「排序有没有被真的改写」这条代码路径。
 */
export const mockRerank: Reranker = async (query, docs) => {
  const queryTerms = [...new Set(tokenize(query))]
  const docTerms = docs.map((d) => tokenize(d.text))
  const n = docs.length || 1
  const weight = new Map<string, number>()
  for (const term of queryTerms) {
    const df = docTerms.filter((terms) => terms.includes(term)).length
    weight.set(term, Math.log(1 + n / (df || n)))
  }
  const totalWeight = queryTerms.reduce((s, t) => s + (weight.get(t) ?? 0), 0) || 1
  return docs
    .map((doc, i) => {
      const terms = docTerms[i]
      let matchedWeight = 0
      let occurrences = 0
      for (const term of queryTerms) {
        const count = terms.filter((t) => t === term).length
        if (count === 0) continue
        matchedWeight += weight.get(term) ?? 0
        occurrences += count
      }
      const coverage = matchedWeight / totalWeight
      const density = occurrences / (occurrences + 12)
      return { id: doc.id, score: Number((0.75 * coverage + 0.25 * density).toFixed(6)) }
    })
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
}

/** 真实交叉编码器：托管走 Cohere Rerank，自部署走 bge-reranker-v2-m3 的 /rerank 端点 */
const httpRerank: Reranker = async (query, docs) => {
  const base = process.env.RERANK_BASE_URL
  if (base) {
    const res = await fetch(`${base.replace(/\/$/, '')}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, texts: docs.map((d) => d.text), raw_scores: false }),
    })
    if (!res.ok) throw new Error(`重排接口返回 ${res.status}`)
    const body = (await res.json()) as Array<{ index: number; score: number }>
    return body.map((r) => ({ id: docs[r.index].id, score: r.score }))
  }
  const apiKey = process.env.COHERE_API_KEY
  if (!apiKey) throw new Error('缺少 COHERE_API_KEY 或 RERANK_BASE_URL（或用 MOCK=1 离线运行）')
  const res = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.RERANK_MODEL ?? 'rerank-v3.5',
      query,
      documents: docs.map((d) => d.text),
      top_n: docs.length,
    }),
  })
  if (!res.ok) throw new Error(`重排接口返回 ${res.status}`)
  const body = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> }
  return body.results.map((r) => ({ id: docs[r.index].id, score: r.relevance_score }))
}

export function createReranker(): { name: string; rerank: Reranker } {
  if (process.env.MOCK === '1') return { name: 'mock-overlap', rerank: mockRerank }
  if (process.env.RERANK_BASE_URL)
    return { name: 'self-hosted:bge-reranker-v2-m3', rerank: httpRerank }
  return { name: `cohere:${process.env.RERANK_MODEL ?? 'rerank-v3.5'}`, rerank: httpRerank }
}

// ---------------------------------------------------------------------------
// 装起来
// ---------------------------------------------------------------------------

export interface Candidate {
  chunk: Chunk
  /** 最终名次，1 起算 */
  rank: number
  rawBm25?: number
  rawVector?: number
  /** 至少有一路的原始分过了自己那条线 */
  admitted: boolean
}

export interface Retriever {
  backendName: string
  rerankerName: string
  byId: Map<string, Chunk>
  /** 每个租户各有多少块进了索引——多租户第一处落点的可观察产物 */
  perTenantChunks: Map<string, number>
  retrieve(query: string, scope: Scope): Promise<Candidate[]>
  /**
   * 把融合前的两路摊开，供自测与「两路盲区」那一段用。
   * 融合是一步不可逆的合并——不留这个出口，你就再也说不清某一条是谁捞回来的（D11 那笔账的教训）。
   */
  probe(
    query: string,
    scope: Scope
  ): Promise<{ keyword: string[]; vector: string[]; fused: string[] }>
  /** 累计的账：查询向量化的 token 数与重排调用次数 */
  usage(): { embedTokens: number; rerankCalls: number; rerankInputTokens: number }
}

export async function createRetriever(chunks: Chunk[], store: VectorStore): Promise<Retriever> {
  const backend: EmbedBackend = createEmbedBackend()
  const byId = new Map(chunks.map((c) => [c.chunkId, c]))

  // 向量一路：全部块一次性批量向量化后写进索引（几百块，批量比逐条调省钱也省时间）
  const vectors = await backend.embed(chunks.map((c) => `${c.headingPath.join(' ')}\n${c.text}`))
  await store.init(backend.dimensions)
  await store.upsert(chunks.map((chunk, i) => ({ chunk, embedding: vectors[i] })))

  // 关键词一路：每个租户一张索引
  const perTenant = new Map<string, Chunk[]>()
  for (const chunk of chunks) {
    const list = perTenant.get(chunk.tenantId) ?? []
    list.push(chunk)
    perTenant.set(chunk.tenantId, list)
  }
  const indexes = new Map([...perTenant].map(([tenantId, list]) => [tenantId, buildBm25(list)]))
  const reranker = createReranker()

  const usage = { embedTokens: 0, rerankCalls: 0, rerankInputTokens: 0 }

  return {
    backendName: backend.name,
    rerankerName: reranker.name,
    byId,
    perTenantChunks: new Map([...perTenant].map(([id, list]) => [id, list.length])),
    usage: () => ({ ...usage }),

    async probe(query, scope) {
      const index = indexes.get(scope.tenantId)
      if (!index) return { keyword: [], vector: [], fused: [] }
      const [qv] = await backend.embed([query])
      const keyword = bm25Search(index, byId, query, scope, RETRIEVAL.perRouteTopK).map(
        (h) => h.chunkId
      )
      const vector = (await store.search(qv, scope, RETRIEVAL.perRouteTopK)).map((h) => h.chunkId)
      return {
        keyword,
        vector,
        fused: rrfFuse([keyword, vector])
          .slice(0, FUSE_KEEP)
          .map((f) => f.id),
      }
    },

    async retrieve(query, scope) {
      const index = indexes.get(scope.tenantId)
      if (!index) return [] // 没有这个租户的索引，就是没有——不要回落成「查全部」
      const [qv] = await backend.embed([query])
      usage.embedTokens += tokenize(query).length

      const keyword = bm25Search(index, byId, query, scope, RETRIEVAL.perRouteTopK)
      const vector = await store.search(qv, scope, RETRIEVAL.perRouteTopK)

      const raw = new Map<string, { bm25?: number; vector?: number }>()
      for (const h of keyword) raw.set(h.chunkId, { ...raw.get(h.chunkId), bm25: h.score })
      for (const h of vector) raw.set(h.chunkId, { ...raw.get(h.chunkId), vector: h.score })

      const fused = rrfFuse([keyword.map((h) => h.chunkId), vector.map((h) => h.chunkId)]).slice(
        0,
        FUSE_KEEP
      )

      const docs = fused
        .map((f) => byId.get(f.id))
        .filter((c): c is Chunk => Boolean(c))
        .map((c) => ({ id: c.chunkId, text: c.text }))
      let ordered: string[]
      if (docs.length === 0) {
        ordered = []
      } else {
        const scored = await reranker.rerank(query, docs)
        usage.rerankCalls += 1
        usage.rerankInputTokens +=
          tokenize(query).length + docs.reduce((s, d) => s + tokenize(d.text).length, 0)
        ordered = scored.map((s) => s.id)
      }

      return ordered.map((chunkId, i) => {
        const s = raw.get(chunkId) ?? {}
        return {
          chunk: byId.get(chunkId) as Chunk,
          rank: i + 1,
          rawBm25: s.bm25,
          rawVector: s.vector,
          admitted:
            (s.bm25 ?? -Infinity) >= RETRIEVAL.gates.bm25MinScore ||
            (s.vector ?? -Infinity) >= RETRIEVAL.gates.vectorMinCosine,
        }
      })
    },
  }
}
