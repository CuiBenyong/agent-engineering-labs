import type { Chunk } from './corpus'
import { embed, rerankScores } from './infra/model'
import type { Scored, Store } from './infra/store'

/** 第一轮每一路各取 20 条：宽，因为召回是漏斗的上游，这一轮漏掉的后面救不回来。 */
export const POOL = 20
/** 第二轮之后只有 5 条进上下文：窄，因为每一条无关内容都在拉低模型的命中率。 */
export const CONTEXT_TOP_K = 5
/** RRF 的平滑常数。60 是这套算法出厂就带的默认值，先用它，别一上来就调。 */
export const RRF_K = 60

export type Mode = 'vector' | 'hybrid' | 'rerank'

export const MODE_LABEL: Record<Mode, string> = {
  vector: '只用向量',
  hybrid: '向量 + 关键词 + RRF',
  rerank: '向量 + 关键词 + RRF + 重排',
}

/**
 * 中文分词的教学实现：中文按 bigram（相邻两字）切，英文与编号按整词切。
 *
 * 为什么是 bigram：Postgres 自带的分词器对中文等于不分词，一整句话会被当成一个 token，
 * 于是关键词那一路查什么都查不到。bigram 是不装扩展时最省事的兜底——「无理由退货」会切成
 * 无理/理由/由退/退货，其中「退货」正好是一个真词，命中就成立。
 * 生产环境请上专门的中文分词扩展（zhparser、pg_jieba 之类），bigram 会让索引膨胀不少。
 */
export function bigrams(text: string): string[] {
  const terms = new Set<string>()
  // 编号、型号、错误码按整词保留：`sf-3000` 拆开就没意义了
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []) terms.add(word)
  for (const run of text.match(/[一-龥]+/g) ?? []) {
    if (run.length === 1) {
      terms.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2))
  }
  return [...terms]
}

/**
 * RRF（Reciprocal Rank Fusion）：`score = Σ 1/(k + rank)`，k = 60，rank 从 1 起算。
 *
 * 关键在于它**只看名次不看分数**。余弦相似度落在 0 到 1、BM25 分数可以是任意正数，
 * 两者量纲不同、分布也不同，加权求和的权重在这批数据上调好，换一批语料就又偏了——
 * 这就是不用加权求和的理由。名次是无量纲的，两路各自排好队，按名次折算成分数再相加，
 * 不需要任何标定。
 */
export function rrfFuse(lists: Scored[][], k: number = RRF_K): Scored[] {
  const scores = new Map<string, number>()
  for (const list of lists) {
    // 每一路传进来的 score 在这里被**丢掉**，只用它排好的名次。这不是偷懒，是本函数的全部要点。
    list.forEach((hit, index) => {
      const rank = index + 1
      scores.set(hit.chunkId, (scores.get(hit.chunkId) ?? 0) + 1 / (k + rank))
    })
  }
  return [...scores.entries()]
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
}

/**
 * 第二轮：把 query 和全部候选一起交给重排模型打 0-10 分，按分数重排。
 * 只对第一轮捞上来的这几十条做——重排贵，对全库做等于没有第一轮。
 * 打平时保留第一轮的名次（`sort` 在 Node 里是稳定的），别让同分的顺序随机跳。
 */
export async function rerankTopK(query: string, candidates: Chunk[]): Promise<Chunk[]> {
  if (candidates.length === 0) return []
  const scores = await rerankScores(
    query,
    candidates.map((chunk) => chunk.content)
  )
  return candidates
    .map((chunk, index) => ({ chunk, score: scores[index] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.chunk)
}

/**
 * 完整的检索管线。三种 mode 走的是同一段代码，差别只在开到第几步——
 * 评估的时候要拿它们对比，所以绝不能各写一份。
 */
export async function retrieve(store: Store, query: string, mode: Mode): Promise<Chunk[]> {
  const [vector] = await embed([query])
  const dense = await store.vectorSearch(vector, POOL)
  if (mode === 'vector') return store.resolve(dense.map((hit) => hit.chunkId))

  const sparse = await store.keywordSearch(bigrams(query), POOL)
  const fused = rrfFuse([dense, sparse])
  const candidates = store.resolve(fused.map((hit) => hit.chunkId))
  if (mode === 'hybrid') return candidates

  return rerankTopK(query, candidates)
}
