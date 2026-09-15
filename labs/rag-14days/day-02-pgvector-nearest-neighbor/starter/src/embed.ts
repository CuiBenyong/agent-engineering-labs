/**
 * 全课统一的 embedding 接口（D2 定义，后面 12 天照抄这个签名，不要改名）：
 *
 *   embed(texts: string[], opts?: { dimensions?: number }): Promise<number[][]>
 *
 * 三种后端在同一个接口下切换，业务代码一行都不用改：
 *
 *   MOCK=1               → 确定性哈希向量（离线，无网络无 key，384 维）
 *   EMBED_BACKEND=local  → @xenova/transformers，Xenova/multilingual-e5-small（384 维）
 *   默认                  → OpenAI text-embedding-3-small（1536 维，支持 dimensions 降维）
 *
 * 一律返回 **L2 归一化后**的向量。归一化之后余弦相似度就等于内积，
 * 距离怎么算、用哪个运算符就都不再是坑了——这一条是本文件最重要的约定。
 */

export interface EmbedOptions {
  /** 只有支持套娃式表示的模型（如 text-embedding-3-small）能截短到更低维度 */
  dimensions?: number
}

export type EmbedFn = (texts: string[], opts?: EmbedOptions) => Promise<number[][]>

/** 哈希向量的默认维度：跟本地开源模型对齐，省内存 */
export const MOCK_DIM = 384

const OPENAI_MODEL = 'text-embedding-3-small'
const LOCAL_MODEL = 'Xenova/multilingual-e5-small'

/**
 * L2 归一化：把向量长度压成 1，只保留方向。
 *
 * 练习 2：算出向量的模长（各分量平方和开根），每个分量都除以它；模长为 0 时原样返回，别除以 0。
 * 提示：全课所有代码都假设向量是归一化过的——余弦相似度直接当内积用，
 * 这一步不做，后面 pgvector 里的 `<#>`（内积）和 `<=>`（余弦）就对不上了。
 */
export function l2Normalize(vec: number[]): number[] {
  return vec
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
 * 确定性哈希向量（全课唯一实现，规格见课程连贯性卡片 3.6）：
 *
 * 1. 文本转小写、去掉所有空白，按 Unicode 字符切成相邻 2-gram（中文按字，英文按字母）。
 * 2. 每个 2-gram 取 FNV-1a 32 位哈希：对维度取模得到下标，最高位决定符号（0 为 +1，1 为 -1）。
 * 3. 累加进向量，最后做 L2 归一化。
 *
 * 它**保留字面重合度**：两段文字共用的 2-gram 越多，向量越接近。
 * 所以 MOCK 模式下向量检索的行为接近关键词检索——
 * 它验证的是代码路径（存得进、查得出、排序对），**不是检索效果**。
 */
export function hashEmbed(text: string, dimensions: number = MOCK_DIM): number[] {
  // 练习 1：按上面三步实现哈希向量。
  //   ① 文本转小写、去掉所有空白，切成相邻 2-gram：[...text] 得到字符数组，取 chars[i] + chars[i+1]
  //   ② 每个 2-gram 用 encoder.encode(...) 转成 UTF-8 字节后交给 fnv1a
  //   ③ 下标 = hash % dimensions，符号 = (hash >>> 31) === 0 ? 1 : -1，累加进 vec，最后 l2Normalize
  // 提示：现在返回的是「所有文档一模一样」的全 1 向量，跑起来你会看到
  //       每个问题的前三名都是 doc-001、doc-002、doc-003——因为它们的距离完全相等。
  void text
  void encoder
  void fnv1a
  const vec = new Array<number>(dimensions).fill(1)
  return l2Normalize(vec)
}

const mockEmbed: EmbedFn = async (texts, opts) => {
  return texts.map((text) => hashEmbed(text, opts?.dimensions ?? MOCK_DIM))
}

/**
 * OpenAI 后端。`dimensions` 走的是套娃式表示（Matryoshka）：
 * 同一个模型训练时就把重要信息压在了前面的维度上，所以直接截短再归一化仍然可用，
 * 不需要另外训练一个低维模型。接口返回的向量已经是归一化的，这里再归一化一次是幂等的，
 * 主要是为了给降维后的向量兜底。
 */
const openaiEmbed: EmbedFn = async (texts, opts) => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('缺少 OPENAI_API_KEY（或用 MOCK=1 离线运行）')
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey })
  const res = await client.embeddings.create({
    model: OPENAI_MODEL,
    input: texts,
    ...(opts?.dimensions ? { dimensions: opts.dimensions } : {}),
  })
  // 按 index 排序：批量请求的返回顺序在协议上不保证跟输入一致
  return [...res.data]
    .sort((a, b) => a.index - b.index)
    .map((item) => l2Normalize(item.embedding as number[]))
}

/**
 * 本地开源后端。e5 系列**要求查询和文档加不同的前缀**，不加前缀检索质量会明显掉——
 * 这一族模型是拿 "query: …" / "passage: …" 这样的成对数据训出来的。
 * 调用方通过 texts 自己带前缀，这里不替它加，避免加两遍。
 *
 * @xenova/transformers 体量较大（要拉 onnxruntime），所以没有写进 dependencies，
 * 用之前先装：pnpm add @xenova/transformers@2.17.2
 */
const localEmbed: EmbedFn = async (texts) => {
  let pipeline: (task: string, model: string) => Promise<unknown>
  try {
    const mod = (await import('@xenova/transformers' as string)) as {
      pipeline: (task: string, model: string) => Promise<unknown>
    }
    pipeline = mod.pipeline
  } catch {
    throw new Error('本地后端需要先安装：pnpm add @xenova/transformers@2.17.2')
  }
  const extractor = (await pipeline('feature-extraction', LOCAL_MODEL)) as (
    input: string[],
    opts: { pooling: string; normalize: boolean }
  ) => Promise<{ tolist: () => number[][] }>
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  return output.tolist()
}

export interface EmbedBackend {
  name: string
  /** 这个后端产出的向量维度，建表时要用 */
  dimensions: number
  embed: EmbedFn
}

/** 唯一的后端选择点。业务代码只认 EmbedBackend，不认后端名字 */
export function createEmbedBackend(): EmbedBackend {
  // EMBED_BACKEND=mock 是「哈希向量 + 真实数据库」的组合，没有 API key 也能玩 pgvector
  if (process.env.MOCK === '1' || process.env.EMBED_BACKEND === 'mock') {
    const dimensions = Number(process.env.EMBED_DIM ?? MOCK_DIM)
    return { name: `mock-hash(${dimensions})`, dimensions, embed: mockEmbed }
  }
  if (process.env.EMBED_BACKEND === 'local') {
    return { name: `local:${LOCAL_MODEL}`, dimensions: 384, embed: localEmbed }
  }
  const dimensions = Number(process.env.EMBED_DIM ?? 1536)
  return { name: `openai:${OPENAI_MODEL}(${dimensions})`, dimensions, embed: openaiEmbed }
}
