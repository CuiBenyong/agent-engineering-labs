import OpenAI from 'openai'
import type { RagConfig } from './config'
import { isMock } from './config'

/**
 * D2 定下的向量化接口，14 天都是这个签名，不许改名：
 *
 *   embed(texts, opts?) => Promise<number[][]>
 *
 * 它是全服务里**最该做成可替换**的一层。理由不是「设计模式教我们面向接口」，
 * 而是很具体的一件事：换 embedding 模型意味着库里所有向量作废、要全量重算。
 * 一年里这件事会发生好几次（涨价、下线、出了更好的多语言模型），
 * 而每一次你都只想改一个配置项、跑一次重建，而不是翻遍全仓库找调用点。
 */
export type Embedder = (texts: string[], opts?: { dimensions?: number }) => Promise<number[][]>

export interface EmbeddingBackend {
  /** 写进 chunk_embeddings.model，用来判断库里的向量是不是当前模型算的 */
  name: string
  dimensions: number
  embed: Embedder
}

/**
 * FNV-1a 32 位哈希。**必须逐 UTF-8 字节做**：一个汉字在 UTF-8 里是 3 个字节，
 * 拿整个字符的 Unicode 码点去异或会算出完全不同的一套向量，
 * 那样这一天存的向量就跟 D2 之后每一天的对不上了。
 */
function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    // Math.imul 做 32 位乘法，直接用 * 会因为超出 53 位精度而丢位
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

const encoder = new TextEncoder()

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0))
  return norm === 0 ? vec : vec.map((x) => x / norm)
}

/**
 * MOCK 用的确定性哈希向量（全课唯一实现，规格见课程连贯性卡片 3.6，D2 起逐字一致）：
 *
 * 1. 文本转小写、**去掉所有空白**，按 Unicode 字符切成相邻 2-gram（中文按字，英文按字母）。
 * 2. 每个 2-gram 取 FNV-1a 32 位哈希（**按 UTF-8 字节**）：对维度取模得到下标，
 *    最高位决定符号（0 为 +1，1 为 -1）。
 * 3. 累加进向量，最后做 L2 归一化。
 *
 * 它保留的是**字面重合度**，所以离线模式下向量检索的行为接近关键词检索。
 * 这一点必须记牢：MOCK 用来验证代码路径，不能用来验证检索效果。
 */
export function hashEmbed(text: string, dimensions: number): number[] {
  const vec = new Array<number>(dimensions).fill(0)

  // 练习 2：按上面注释里的三步实现确定性哈希向量。
  //   a) [...text.toLowerCase().replace(/\s+/gu, '')] 去掉空白再切成字符数组，
  //      相邻两个字符组成一个 2-gram；
  //   b) 用 `fnv1a(encoder.encode(gram))` 取哈希——**注意是 encoder.encode，
  //      也就是按 UTF-8 字节算**。一个汉字在 UTF-8 里是 3 个字节，
  //      如果图省事按整个字符的码点异或（无论 UTF-16 还是 Unicode 码点），
  //      算出来是另一套向量，跟 D2 之后每一天都对不上；
  //   c) 下标取 `hash % dimensions`，符号看最高位（`hash >>> 31 === 0` 取 +1，否则 -1），
  //      累加完用 l2Normalize 归一化。
  //
  // 提示：l2Normalize 里已经处理了全零向量（空文本）。自己写的话别忘了这一步——
  // 除以 0 会得到一排 NaN，而 NaN 在排序里不报错、只是悄悄把结果搅乱。
  //
  // 现在返回的是一排零：向量检索照样能跑完，但每一条的余弦相似度都是 0，
  // 自测里「向量这一路真的算出了相似度」那一项会是 ❌。
  void text
  void fnv1a
  void encoder
  void l2Normalize
  return vec
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot // 两边都已经归一化过，内积就是余弦相似度（D2 讲过这个前提）
}

export function createEmbedder(cfg: RagConfig): EmbeddingBackend {
  const { backend, model, dimensions } = cfg.embedding
  const useMock =
    backend === 'mock' || (backend === 'auto' && (isMock() || !process.env.OPENAI_API_KEY))

  if (useMock) {
    return {
      name: `mock-hash-${dimensions}`,
      dimensions,
      embed: async (texts) => texts.map((t) => hashEmbed(t, dimensions)),
    }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY（或用 MOCK=1 离线运行）')
  const client = new OpenAI({ apiKey })

  return {
    name: `${model}-${dimensions}`,
    dimensions,
    embed: async (texts, opts) => {
      // text-embedding-3-small 支持 dimensions 参数直接降维，省一半存储；
      // 降到多少合适、损失了什么，D2 有一节专门讲
      const res = await client.embeddings.create({
        model,
        input: texts,
        dimensions: opts?.dimensions ?? dimensions,
      })
      // 按 index 排序：批量请求的返回顺序在协议上不保证跟输入一致。
      // 再归一化一次是幂等的，主要是给降维后的向量兜底——cosine() 的前提就是两边都归一化过
      return [...res.data].sort((a, b) => a.index - b.index).map((d) => l2Normalize(d.embedding))
    },
  }
}
