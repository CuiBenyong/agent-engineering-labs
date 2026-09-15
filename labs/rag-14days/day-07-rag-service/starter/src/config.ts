import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 全服务只有这一处「参数」。切块策略、embedding 后端、检索走几路，
 * 都在 rag.config.json 里改，不改代码。
 *
 * 为什么值得较真：这一周每天都在换一个零件（切法、模型、索引），
 * 如果每次换都要动 ingest 或者 retrieve 的代码，就没法回答「换回去会怎样」这个问题——
 * 而这恰恰是第二周每天都要问的。
 */
export interface RagConfig {
  chunking: {
    /** heading = 按标题层级切（D4 的「按文档结构」）；fixed = 定长滑窗 */
    strategy: 'heading' | 'fixed'
    maxChars: number
    minChars: number
    overlapChars: number
  }
  embedding: {
    /** auto = 有 key 走接口、没 key 走确定性哈希；mock / openai 可以强制 */
    backend: 'auto' | 'mock' | 'openai'
    model: string
    dimensions: number
  }
  retrieval: {
    routes: ('bm25' | 'vector')[]
    perRouteTopK: number
    topK: number
    weights: { bm25: number; vector: number }
    /** 每一路各自的「够得着」门槛，低于它的候选不进上下文 */
    gates: { bm25MinScore: number; vectorMinCosine: number }
    bm25: { k1: number; b: number }
  }
  generation: {
    model: string
    maxContextChars: number
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 配置文件与语料一样放在 lab 根目录，starter 与 solution 共用同一份 */
export const CONFIG_PATH = join(ROOT, 'rag.config.json')
export const CORPUS_DIR = join(ROOT, 'corpus')
export const BASELINE_D1_PATH = join(ROOT, 'baseline-d1.json')

export function loadConfig(): RagConfig {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as RagConfig

  // 环境变量只做覆盖，不做定义：配置文件永远是那份「说明书」，
  // 环境变量是你临时想试一下别的值时的快捷方式。
  if (process.env.CHUNK_STRATEGY) {
    cfg.chunking.strategy = process.env.CHUNK_STRATEGY as RagConfig['chunking']['strategy']
  }
  if (process.env.EMBED_BACKEND) {
    cfg.embedding.backend = process.env.EMBED_BACKEND as RagConfig['embedding']['backend']
  }
  if (process.env.ROUTES) {
    cfg.retrieval.routes = process.env.ROUTES.split(',').map((r) => r.trim() as 'bm25' | 'vector')
  }
  if (process.env.TOP_K) cfg.retrieval.topK = Number(process.env.TOP_K)

  if (cfg.retrieval.routes.length === 0) throw new Error('retrieval.routes 不能为空')
  return cfg
}

export const PORT = Number(process.env.PORT ?? 3057)
export const isMock = (): boolean => process.env.MOCK === '1'
