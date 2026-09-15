// 本 lab 唯一的网络出口：embedding 接口与 rerank 打分接口，两个都在函数最前面打桩。
// embedding 那一段的假向量实现来自 D12（`src/infra/embeddings.ts`），本天只改了两处，
// 见下面 `fakeEmbedding` 上的注释。rerank 是本天新增的。

export const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
export const EMBEDDING_DIM = 1536 // 模型属性，不是可调参数（D12 定，本天沿用）
export const RERANK_SCALE = 10 // 教学版 rerank：让模型给每条候选打 0-10 分

const EMBEDDING_URL = 'https://openrouter.ai/api/v1/embeddings'
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const PRICE_USD_PER_1M_TOKENS = 0.02 // D12 定的口径，本天沿用

/** 字符数按 1:1 粗估 token（D6 定的保守口径，宁可高估）。 */
export function embeddingCostUsd(texts: string[]): number {
  const tokens = texts.reduce((sum, text) => sum + text.length, 0)
  return (tokens / 1_000_000) * PRICE_USD_PER_1M_TOKENS
}

// ---------------------------------------------------------------------------
// embedding（来自 D12，本天只改假向量那一段）
// ---------------------------------------------------------------------------

export async function embed(texts: string[]): Promise<number[][]> {
  if (process.env.MOCK === '1') return texts.map(fakeEmbedding)
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  })
  if (!res.ok) throw new Error(`embedding 调用失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
  return json.data.map((item) => item.embedding)
}

/**
 * MOCK=1 用的假向量：字符词袋 + 带符号的特征哈希，确定性且语义可分（D12 已经解释过为什么
 * 不能用随机数）。本天在 D12 的基础上加了两笔，都是为了让「向量路和关键词路各有各的盲区」
 * 这个现象在离线状态下真的能看见：
 *
 * 1. **同义改写**：真实 embedding 天生懂「忌口」和「过敏」讲的是一回事，字符词袋不懂。
 *    这里用一张小同义表在算向量之前把变体归一到同一个写法，把这个性质模拟出来。
 *    关键词那一路**不**用这张表——那正是真实世界里两路的差别所在。
 * 2. **编号脱敏**：真实 embedding 对精确的型号、错误码、订单号很不敏感，它大体只知道
 *    「这里有一串编号」。所以凡是带数字的词一律折叠成同一个桶，`E4032` 与 `E5011`
 *    在向量眼里长得一模一样——这条 query 只能靠关键词那一路救回来。
 */
function fakeEmbedding(text: string): number[] {
  const bag = normalize(rawBag(canonicalize(text)))
  // 掺进一个所有文本共有的公共方向。真实 embedding 也有这个性质（各向异性）：
  // 任意两段文本的余弦相似度不从 0 起步，而从 0.2 上下起步。
  const mix = Math.sqrt(1 - BASE_WEIGHT * BASE_WEIGHT)
  return normalize(bag.map((value, i) => BASE_WEIGHT * COMMON_DIRECTION[i] + mix * value))
}

/**
 * 一张手写的小同义表：把口语变体归一到知识库里的写法。
 * 真实 embedding 与真实 rerank 模型不需要它，离线版只能靠它模拟「懂同义」这件事。
 */
const SYNONYMS: Array<[string, string]> = [
  ['货到付款', '到付'],
  ['申请退款', '退货'],
  ['退款', '退货'],
  ['退掉', '退货'],
  ['退回', '退货'],
  ['过敏', '忌口'],
  ['不能吃', '忌口'],
  ['邮费', '运费'],
  ['快递费', '运费'],
  ['开票', '发票'],
  ['税票', '发票'],
  ['收货', '签收'],
  ['送货', '配送'],
  ['派送', '配送'],
  ['物流', '配送'],
  ['会员分', '积分'],
  ['售后单', '工单'],
  ['质保', '保修'],
  ['号码', '尺码'],
  ['大小', '尺码'],
  ['宕机', '故障'],
  ['打不开', '故障'],
  ['kubernetes', 'k8s'],
]

/** 只在 embedding 与 rerank 这两个「懂语义」的出口上做归一，关键词那一路不做。 */
export function canonicalize(text: string): string {
  let out = text.toLowerCase()
  for (const [variant, canonical] of SYNONYMS) out = out.split(variant).join(canonical)
  return out
}

/** 出现频次最高的那批虚词：不过滤掉，「的」会靠词频压过所有实词。 */
const STOP_CHARS = new Set(
  '的了是在和也都不有个我你他她它这那就要会对与及以为很还把被从到中上下里而并或者一二三'.split('')
)

// 词袋：中文按单字切、英文按词切；只看「出现过没有」不看几次。每个词散到 2 个维度并带正负号
// （特征哈希的标准做法）。带数字的词一律折叠成同一个桶——见 fakeEmbedding 的第 2 条说明。
function rawBag(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0)
  const terms = text.match(/[一-龥]|[a-z0-9-]+/g) ?? []
  const seen = new Set<string>()
  for (const raw of terms) {
    const term = /\d/.test(raw) ? '«num»' : raw
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

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? vector : vector.map((value) => value / norm)
}

// ---------------------------------------------------------------------------
// rerank（本天新增）
// ---------------------------------------------------------------------------

/**
 * 教学版 rerank：把 query 和全部候选一次性交给对话模型，让它给每条打 0-10 分。
 * 一次调用打完 40 条，成本是一次带 40 段正文的对话请求。
 *
 * 生产版应该换成专用的 cross-encoder 重排模型，代价是多一次 100-300ms 的调用
 * 加一台推理机器；接口形状（进 query + 候选，出一列分数）是一样的，所以换的时候
 * 只动这一个函数。
 */
export async function rerankScores(query: string, candidates: string[]): Promise<number[]> {
  if (candidates.length === 0) return []
  if (process.env.MOCK === '1') return candidates.map((text) => fakeRerankScore(query, text))

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const listed = candidates.map((text, i) => `[${i + 1}] ${text.replace(/\s+/g, ' ')}`).join('\n')
  const prompt =
    `问题：${query}\n\n下面是 ${candidates.length} 条候选资料，给每一条打 0 到 ${RERANK_SCALE} 分，` +
    `表示它对回答上面这个问题有多大帮助。只输出一个 JSON 数组，长度必须是 ${candidates.length}，` +
    `元素是整数，不要输出别的内容。\n\n${listed}`

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  })
  if (!res.ok) throw new Error(`rerank 调用失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  const raw = json.choices[0].message.content
  const match = raw.match(/\[[\s\S]*\]/)
  // 模型可能少给或多给几个分数。缺的按 0 补齐，多的截掉——排序阶段不该因为模型抽风就整轮失败。
  const parsed: unknown = match ? JSON.parse(match[0]) : []
  const scores = Array.isArray(parsed) ? parsed : []
  return candidates.map((_, i) => {
    const value = Number(scores[i])
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), RERANK_SCALE) : 0
  })
}

/**
 * MOCK=1 用的假打分器。它和向量路的本质区别在于**把 query 和候选放在一起看**：
 * 逐个检查 query 里的实义词有没有落在这一条候选里，覆盖得越全分越高。
 * 真实的 cross-encoder 就是靠「一起看」赢过「各自算向量再比距离」的，
 * 这里用最笨的词项覆盖率把这个机制复现出来。
 */
function fakeRerankScore(query: string, text: string): number {
  const haystack = canonicalize(text)
  const terms = contentTerms(canonicalize(query))
  const total = terms.reduce((sum, term) => sum + term.weight, 0)
  if (total === 0) return 0
  const hit = terms
    .filter((term) => haystack.includes(term.text))
    .reduce((sum, term) => sum + term.weight, 0)
  return Math.round((hit / total) * RERANK_SCALE)
}

// ---------------------------------------------------------------------------
// 对话（拿检索结果生成带引用的回答）
// ---------------------------------------------------------------------------

export async function chat(prompt: string): Promise<string> {
  if (process.env.MOCK === '1') return fakeAnswer(prompt)
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MODEL ?? 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  return json.choices[0].message.content
}

/**
 * 假回答：摘一句 [1] 的原文，规规矩矩标上 [1] 和 [2]，**然后故意多引一个 [9]**。
 * 这不是恶趣味——真实模型就是会引用你根本没给它的编号，而且写得同样通顺。
 * 上下文里只有 5 条时它写 [9]，你不做后处理就会原样发给用户。
 */
function fakeAnswer(prompt: string): string {
  const first = prompt.match(/\[1\] （[^）]*）([^\n]{0,60})/)
  const gist = first ? first[1].replace(/\s+/g, '') : '资料里没有直接的说明'
  return `根据资料，${gist}[1]。同一条规则在另一份文档里也有说明 [2][9]。`
}

interface WeightedTerm {
  text: string
  weight: number
}

/**
 * 从 query 里挑出实义词：编号型号权重 3、相邻两字权重 2、单字权重 1。
 * 连着两个字都对上，比同样两个字散落在段落各处有说服力得多；
 * 只给单字算分的话，长文档靠字数就能蒙到高分。
 */
function contentTerms(text: string): WeightedTerm[] {
  const terms = new Map<string, number>()
  const keep = (word: string, weight: number): void => {
    terms.set(word, Math.max(terms.get(word) ?? 0, weight))
  }
  for (const word of text.match(/[a-z0-9][a-z0-9-]*/g) ?? []) keep(word, 3)
  for (const run of text.match(/[一-龥]+/g) ?? []) {
    for (const char of run) if (!STOP_CHARS.has(char)) keep(char, 1)
    for (let i = 0; i + 1 < run.length; i += 1) {
      const pair = run.slice(i, i + 2)
      if (!STOP_CHARS.has(pair[0]) && !STOP_CHARS.has(pair[1])) keep(pair, 2)
    }
  }
  return [...terms].map(([word, weight]) => ({ text: word, weight }))
}
