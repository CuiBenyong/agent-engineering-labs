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
  // 练习 1：把中文按 bigram（相邻两字）切开，英文与编号（`sf-3000`、`e4032`）按整词保留。
  // 提示：`text.match(/[一-龥]+/g)` 先拿到中文连续段，再逐个取 slice(i, i + 2)；
  //       编号用 `text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g)` 单独收，别把它也切成两半。
  //
  // 下面这行就是「不分词」的效果——Postgres 自带的分词器对中文干的正是这件事：
  // 一整句中文被当成一个 token，于是关键词那一路查什么都查不到。跑一次自检看现象。
  return text.toLowerCase().split(/\s+/).filter(Boolean)
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
  // 练习 2：改成 RRF——把每一路传进来的 score **丢掉**，只用它排好的名次，
  // 累加 1 / (k + rank)，rank 从 1 起算，k 用参数里的 60。
  // 提示：`list.forEach((hit, index) => ...)`，`index + 1` 就是 rank。
  //
  // 下面这版是最容易想到、也最容易出事的做法：两路分数各占一半直接相加。
  // 余弦相似度在 0 到 1 之间，BM25 分数可以是二十几——量纲差一个数量级，
  // 关键词那一路会把向量那一路整个压掉。跑一次自检，看第 3、4 项的现象。
  void k
  const scores = new Map<string, number>()
  for (const list of lists) {
    for (const hit of list)
      scores.set(hit.chunkId, (scores.get(hit.chunkId) ?? 0) + 0.5 * hit.score)
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
  // 练习 3：调 `rerankScores(query, 每条候选的正文)` 拿到 0-10 的分数，按分数从高到低重排。
  // 提示：分数打平时要保留第一轮的名次，别让同分的顺序随机跳——
  //       `Array.prototype.sort` 在 Node 里是稳定排序，只按分数排就够了。
  //
  // 下面这版直接把第一轮的顺序原样交出去，等于没有第二轮。
  void query
  void rerankScores
  return candidates
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
