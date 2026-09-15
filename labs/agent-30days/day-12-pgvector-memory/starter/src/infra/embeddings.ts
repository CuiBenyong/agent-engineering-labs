// embedding 是本 lab 的两个网络出口之一（另一个是对话模型），所以在这里打桩：MOCK=1 时
// 一行真实请求都不执行。它和对话接口是两回事——输入文本、输出定长向量，没有 temperature、
// 不流式、同样的输入永远得到同样的输出。
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
export const EMBEDDING_DIM = 1536

const EMBEDDING_URL = 'https://openrouter.ai/api/v1/embeddings'
const PRICE_USD_PER_1M_TOKENS = 0.02

/** 字符数按 1:1 粗估 token（D6 定的保守口径，宁可高估）。 */
export function embeddingCostUsd(texts: string[]): number {
  const tokens = texts.reduce((sum, text) => sum + text.length, 0)
  return (tokens / 1_000_000) * PRICE_USD_PER_1M_TOKENS
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (process.env.MOCK === '1') return texts.map(fakeEmbedding)
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // 批量传：一次请求算 N 条，省的是往返延迟不是钱——计费按 token，与批次无关
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  })
  if (!res.ok) throw new Error(`embedding 调用失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
  return json.data.map((item) => item.embedding)
}

// MOCK=1 用的假向量：字符词袋 + 带符号的特征哈希，不是随机数。两个要求缺一不可——
// 确定性：同一段文字永远得到同一串向量（用 Math.random 检索结果每次都在跳，你会以为是
// 相似度算错了）；语义可分：共享的字越多、重合的维度越多、余弦相似度越高，离线也能看到
// 「换一个 query，命中的记忆跟着变」。它的分辨率很粗，在它眼里「番茄」和「西红柿」毫无
// 关系，完全无关的 query 也可能拿到 0.3 上下的分数——真实 embedding 才有语义。
function fakeEmbedding(text: string): number[] {
  const bag = normalize(rawBag(text))
  // 掺进一个所有文本共有的公共方向。真实 embedding 也有这个性质（各向异性）：任意两段
  // 文本的余弦相似度不从 0 起步而从 0.2 上下起步。没有这一步，纯词袋的分数会低到
  // MIN_SCORE 那条阈值永远够不着，你会误以为是阈值定错了。
  const mix = Math.sqrt(1 - BASE_WEIGHT * BASE_WEIGHT)
  return normalize(bag.map((value, i) => BASE_WEIGHT * COMMON_DIRECTION[i] + mix * value))
}

/** 出现频次最高的那批虚词：不过滤掉，「的」会靠词频压过所有实词。 */
const STOP_CHARS = new Set(
  '的了是在和也都不有个我你他她它这那就要会对与及以为很还把被从到中上下里而并或者一二三'.split('')
)

// 词袋：中文按单字切、英文数字按词切；只看「出现过没有」不看几次。每个词散到 2 个维度并带
// 正负号——特征哈希（feature hashing）的标准做法，撞进同一维时正负相消，不会像全取正号
// 那样把无关文本也拉近。
function rawBag(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0)
  const terms = text.toLowerCase().match(/[一-龥]|[a-z0-9]+/g) ?? []
  const seen = new Set<string>()
  for (const term of terms) {
    if (term.length === 1 && STOP_CHARS.has(term)) continue
    if (seen.has(term)) continue
    seen.add(term)
    let hash = 2166136261
    for (let i = 0; i < term.length; i += 1) {
      hash = Math.imul(hash ^ term.charCodeAt(i), 16777619)
    }
    for (let k = 0; k < 2; k += 1) {
      hash = Math.imul(hash ^ (hash >>> 13), 2246822507)
      const bits = hash >>> 0
      vector[bits % EMBEDDING_DIM] += (bits >>> 31) & 1 ? 1 : -1
    }
  }
  return vector
}

const BASE_WEIGHT = 0.5

/** 一条确定性的稠密单位向量，充当「所有文本共有的公共方向」。 */
const COMMON_DIRECTION = ((): number[] => {
  let hash = 0x9e3779b9
  const vector = new Array<number>(EMBEDDING_DIM)
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507)
    vector[i] = (hash >>> 0) / 4294967296 - 0.5
  }
  return normalize(vector)
})()

/** 归一化到单位长度：真实 embedding 接口返回的向量也是归一化过的。 */
function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? vector : vector.map((value) => value / norm)
}
