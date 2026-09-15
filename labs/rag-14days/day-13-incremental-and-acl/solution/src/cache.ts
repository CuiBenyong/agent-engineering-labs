import { createHash } from 'node:crypto'
import type { Department } from './chunk.js'

/**
 * 三层缓存。三层的实现是同一个 Map，**唯一的区别在 key 里放了什么**：
 *
 *   L1 答案缓存    问题 → 最终答案      key 要放：问题、权限范围、索引版本、模型与提示词版本
 *   L2 检索缓存    检索式 → 命中块列表  key 要放：问题、权限范围、topK、索引版本、向量后端
 *   L3 向量缓存    文本 → 向量          key 要放：文本、向量后端（就这两样）
 *
 * 「什么时候必须失效」这个问题，等价于「key 里有没有把那样东西算进去」。
 * key 少放一样，那样东西变了缓存就不会失效——它不报错，只是安静地一直给旧答案。
 *
 * 三层的寿命也因此完全不同：
 *   L3 是**内容寻址**的，文本不变、模型不变，向量就永远不会变，可以放很久甚至持久化。
 *   L2 绑在索引版本上，一次同步全作废。
 *   L1 最脆：索引、权限、模型、提示词，任何一样动了都得作废。
 */

export interface CacheStats {
  hits: number
  misses: number
}

export class Cache<V> {
  private readonly map = new Map<string, V>()
  readonly stats: CacheStats = { hits: 0, misses: 0 }

  constructor(readonly name: string) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key)
    if (hit === undefined) this.stats.misses += 1
    else this.stats.hits += 1
    return hit
  }

  set(key: string, value: V): void {
    this.map.set(key, value)
  }

  get size(): number {
    return this.map.size
  }

  /** 命中率。分母是 0 时返回 0，别在自测输出里印出 NaN */
  get hitRate(): number {
    const total = this.stats.hits + this.stats.misses
    return total === 0 ? 0 : this.stats.hits / total
  }

  clear(): void {
    this.map.clear()
    this.stats.hits = 0
    this.stats.misses = 0
  }
}

/**
 * key 的各个部分用 NUL 字节连接再哈希。用逗号之类的普通分隔符会出事：
 * 问题正文里本来就可能有逗号，于是两组不同的成分能拼出同一个字符串，两个请求共用一个 key。
 */
function digest(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 索引版本号。**任何一次真的改动了索引的同步，都要把它 +1。**
 * 有了它，「索引变了要让缓存失效」这件事就不需要逐条去删缓存——
 * 旧 key 再也不会被算出来，自然就没人读得到了（这叫「版本化失效」，比精确删除可靠得多，
 * 因为精确删除要求你能列出「这次改动影响了哪些问题」，而那是列不出来的）。
 */
export class IndexVersion {
  private n = 1
  get value(): number {
    return this.n
  }
  bump(): number {
    this.n += 1
    return this.n
  }
}

/** 权限范围的规范化写法：排序 + join，保证 ['hr','eng'] 与 ['eng','hr'] 得到同一个 key */
export function scopeKey(departments?: Department[]): string {
  return departments ? [...departments].sort().join(',') : '*'
}

export type KeyPolicy = 'buggy' | 'fixed'

export interface AnswerKeyInput {
  question: string
  departments?: Department[]
  indexVersion: number
  /** 模型 id 与提示词版本一起进 key：换模型或改提示词，旧答案同样不能再用 */
  model: string
  promptVersion: string
}

/**
 * L1 答案缓存的 key。
 *
 * `buggy` 是几乎所有人第一版会写出来的样子——「同一个问题就返回同一个答案」。
 * 它有两个后果，实验里都能跑出来：
 *   1. 文档改了，答案还是旧的（该失效却没失效）
 *   2. 换个人来问，会拿到别人权限范围内的答案（越权，而且日志上看不出来）
 */
export function answerCacheKey(policy: KeyPolicy, input: AnswerKeyInput): string {
  if (policy === 'buggy') return digest(['answer', input.question])
  return digest([
    'answer',
    input.question,
    scopeKey(input.departments),
    input.indexVersion,
    input.model,
    input.promptVersion,
  ])
}

export interface RetrievalKeyInput {
  question: string
  departments?: Department[]
  topK: number
  indexVersion: number
  backend: string
}

/**
 * L2 检索缓存的 key。比 L1 少了模型与提示词（换模型不影响检索结果），
 * 多了 topK 与向量后端（取几条、用哪套向量，都会改变命中列表）。
 */
export function retrievalCacheKey(input: RetrievalKeyInput): string {
  return digest([
    'retrieval',
    input.question,
    scopeKey(input.departments),
    input.topK,
    input.indexVersion,
    input.backend,
  ])
}

/**
 * L3 向量缓存的 key：只有文本和后端名。
 * **不放索引版本**——这是刻意的。同步一次就把几万条向量全作废，等于每次同步都全量重算，
 * 那恰好是今天要消灭的那件事。文本没变，它的向量就没变，跟索引里发生了什么无关。
 */
export function embedCacheKey(text: string, backend: string): string {
  return digest(['embed', backend, text])
}

export type EmbedFnLike = (texts: string[]) => Promise<number[][]>

/**
 * 给 embed 套一层缓存。只把没命中的那些文本发出去，回来再按原顺序拼回去——
 * 顺序错位是这段代码唯一容易写错的地方，所以这里用下标数组显式对齐，不靠 filter 的巧合。
 */
export function cachedEmbed(
  embed: EmbedFnLike,
  cache: Cache<number[]>,
  backend: string
): EmbedFnLike & { calls: () => number } {
  let calls = 0
  const wrapped = async (texts: string[]): Promise<number[][]> => {
    const out = new Array<number[] | undefined>(texts.length)
    const missIndexes: number[] = []
    texts.forEach((text, i) => {
      const hit = cache.get(embedCacheKey(text, backend))
      if (hit) out[i] = hit
      else missIndexes.push(i)
    })
    if (missIndexes.length > 0) {
      calls += missIndexes.length
      const fresh = await embed(missIndexes.map((i) => texts[i]))
      missIndexes.forEach((i, j) => {
        out[i] = fresh[j]
        cache.set(embedCacheKey(texts[i], backend), fresh[j])
      })
    }
    return out as number[][]
  }
  wrapped.calls = () => calls
  return wrapped as EmbedFnLike & { calls: () => number }
}
