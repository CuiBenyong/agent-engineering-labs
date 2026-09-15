/**
 * 向量接口。签名在第二天定下，全课十四天照抄，不要改名：
 *
 *   embed(texts, opts?) => Promise<number[][]>
 *
 * 本天用它做混合检索的向量一路：全部块建一次索引，每个查询再算一次。
 * 一次性的建索引成本与每次查询成本要分开记，见 src/cost.ts。
 *
 * 三个后端：
 * - `MOCK=1`        走确定性哈希向量（见下），无网络、无 key
 * - `EMBED_BACKEND=local`  本地开源模型，实现见第二天的 lab，本天不重复
 * - 默认            OpenAI text-embedding-3-small
 */

/** 默认维度 384，与本地开源模型对齐，省内存 */
export const DEFAULT_DIM = 384

const isMock = () => process.env.MOCK === '1'

/** L2 归一化：把向量长度压成 1，只保留方向。零向量原样返回，避免除以 0 */
export function l2Normalize(vec: number[]): number[] {
  let sum = 0
  for (const x of vec) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm === 0) return vec
  return vec.map((x) => x / norm)
}

/**
 * FNV-1a 32 位哈希。输入是 UTF-8 字节，这样 JS 和 Python 算出来是同一个数——
 * 全课 14 天的 mock 向量必须完全一致，否则今天存的向量跟别的天对不上。
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

/**
 * 确定性哈希向量（全课唯一实现，规格见课程连贯性卡片 3.6，实现与 D2 逐字一致）：
 *
 * 1. 文本转小写、去掉所有空白，按 Unicode 字符切成相邻 2-gram（中文按字，英文按字母）。
 * 2. 每个 2-gram 取 FNV-1a 32 位哈希：对维度取模得到下标，最高位决定符号（0 为 +1，1 为 -1）。
 * 3. 累加进向量，最后做 L2 归一化。
 *
 * 这套向量**保留字面重合度**，所以 mock 模式下的语义切分行为接近「按用词是否突变来断句」。
 * 它足够验证代码路径与断点逻辑，但不能用来评价真实 embedding 的语义能力。
 */
export function hashEmbed(text: string, dimensions: number = DEFAULT_DIM): number[] {
  const vec = new Array<number>(dimensions).fill(0)
  const chars = [...text.toLowerCase().replace(/\s+/gu, '')]
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const hash = fnv1a(encoder.encode(chars[i] + chars[i + 1]))
    const index = hash % dimensions
    const sign = hash >>> 31 === 0 ? 1 : -1
    vec[index] += sign
  }
  return l2Normalize(vec)
}

export async function embed(
  texts: string[],
  opts: { dimensions?: number } = {}
): Promise<number[][]> {
  const dim = opts.dimensions ?? DEFAULT_DIM

  if (isMock()) return texts.map((t) => hashEmbed(t, dim))

  if (process.env.EMBED_BACKEND === 'local') {
    throw new Error('本地开源后端的实现在第二天的 lab 里，本天请用默认后端或 MOCK=1')
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY（或用 MOCK=1 离线运行）')

  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey })
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
    dimensions: dim, // 3-small 支持降维，384 维的召回损失很小、存储省四分之三
  })
  return res.data.map((row) => row.embedding)
}

/** 两个已归一化的向量，余弦相似度就是点积 */
export function cosine(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}
