import { tokenize } from './retrieve'

/**
 * 重排（rerank）。全课统一接口（连贯性卡片 3.7ter），D10–D12 直接复用。
 *
 * 双编码器（bi-encoder，也就是我们前面用的 embedding）是**查询和文档各自编码**，
 * 编完就成了两个互不相干的向量，只能靠一次内积把它们凑到一起——
 * 文档向量可以离线算好、建索引、毫秒级查全库，代价是查询和文档从来没有「见过面」。
 *
 * 交叉编码器（cross-encoder）反过来：把查询和文档**拼成一段文本一起送进模型**，
 * 每一层注意力都能让查询的词去看文档的词。它准，但**没有任何东西可以预先算好**：
 * N 篇文档就要跑 N 次前向，全库重排等于把整个语料在每次提问时重算一遍。
 * 所以重排只能站在召回后面，作用于**融合后的前 20 条**。
 */

export interface RerankDoc {
  id: string
  text: string
}

export type Reranker = (
  query: string,
  docs: RerankDoc[]
) => Promise<Array<{ id: string; score: number }>>

export interface RerankBackend {
  name: string
  rerank: Reranker
  /** 真实后端每次重排要走一次网络往返；mock 替身不走 */
  callsNetwork: boolean
}

/** 托管后端的默认模型（D9 定，D10–D12 沿用） */
const COHERE_MODEL = 'rerank-v3.5'
/** 自部署后端的默认模型：多语言、Apache-2.0，能塞进一张消费级显卡 */
const SELF_HOSTED_MODEL = 'BAAI/bge-reranker-v2-m3'

/**
 * `MOCK=1` 下的确定性替身：按「查询词元与文档词元的加权重合度」打分。
 *
 * 权重来自**候选集内**的文档频率：一个在 20 条候选里全都出现的词元没有区分度，
 * 权重接近 0；只在一两条里出现的词元权重最高。这一步不需要模型、不需要网络，
 * 同样的输入永远得到同样的分数——可复现是它唯一的目的。
 *
 * **它不代表真实重排效果。** 真交叉编码器能读懂「组长是谁」和「周敏」是一回事，
 * 而这个替身只会数词。它验证的是代码路径：排序有没有真的被改写、
 * 名次变化有没有传导到指标上。
 */
export const mockRerank: Reranker = async (query, docs) => {
  // 练习 3：实现确定性的重排替身。
  //   - 用 tokenize() 把查询和每篇文档切成词元。
  //   - 给每个查询词元一个权重：它在这 20 条候选里出现得越少越值钱
  //     （提示：log(1 + 候选数 / 该词元命中的候选数)，全都命中时权重接近 0）。
  //   - 打分 = 0.75 × 加权覆盖率 + 0.25 × 命中次数的饱和值（次数 / (次数 + 12)），
  //     饱和是为了不让长文档靠堆字数取胜。
  //   - 同分按 id 兜底排序。**不许调网络，不许用随机数**：同样输入必须永远同样输出。
  //
  // 下面这行是占位实现：原样返回融合后的顺序，等于「没有重排」。
  // 跑起来第七段会显示被改写的位置是 0，验收第三项是 ❌。
  void query
  return docs.map((doc) => ({ id: doc.id, score: 0 }))
}

/** 托管交叉编码器：Cohere Rerank。只用 fetch，不额外引依赖 */
const cohereRerank: Reranker = async (query, docs) => {
  const apiKey = process.env.COHERE_API_KEY
  if (!apiKey) throw new Error('缺少 COHERE_API_KEY（或用 MOCK=1 离线运行）')
  const res = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.RERANK_MODEL ?? COHERE_MODEL,
      query,
      documents: docs.map((d) => d.text),
      top_n: docs.length,
    }),
  })
  if (!res.ok) throw new Error(`重排接口返回 ${res.status}：${await res.text()}`)
  const body = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> }
  return body.results.map((r) => ({ id: docs[r.index].id, score: r.relevance_score }))
}

/**
 * 自部署交叉编码器：把 BAAI/bge-reranker-v2-m3 挂在一个 HTTP 端点后面
 * （text-embeddings-inference 的 /rerank 就是这个形状）。
 * 它是「能不能自己部署」这个问题的答案：权重开源、多语言、一张显卡放得下。
 */
const selfHostedRerank: Reranker = async (query, docs) => {
  const base = process.env.RERANK_BASE_URL
  if (!base) throw new Error('缺少 RERANK_BASE_URL')
  const res = await fetch(`${base.replace(/\/$/, '')}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, texts: docs.map((d) => d.text), raw_scores: false }),
  })
  if (!res.ok) throw new Error(`重排接口返回 ${res.status}：${await res.text()}`)
  const body = (await res.json()) as Array<{ index: number; score: number }>
  return body.map((r) => ({ id: docs[r.index].id, score: r.score }))
}

/** 唯一的后端选择点。业务代码只认 Reranker，不认后端名字 */
export function createRerankBackend(): RerankBackend {
  if (process.env.MOCK === '1') {
    return { name: 'mock-overlap', rerank: mockRerank, callsNetwork: false }
  }
  if (process.env.RERANK_BASE_URL) {
    return {
      name: `self-hosted:${process.env.RERANK_MODEL ?? SELF_HOSTED_MODEL}`,
      rerank: selfHostedRerank,
      callsNetwork: true,
    }
  }
  return {
    name: `cohere:${process.env.RERANK_MODEL ?? COHERE_MODEL}`,
    rerank: cohereRerank,
    callsNetwork: true,
  }
}
