import { createMemoryStore } from './memory-store'
import { createPgStore } from './pg-store'

export interface MemoryRow {
  id: string
  userId: string
  sourceRunId: string | null
  content: string
  embedding: number[]
  createdAt: string
}

/** score 是余弦相似度，越接近 1 越像。 */
export interface SearchHit {
  id: string
  content: string
  createdAt: string
  score: number
}

/**
 * 记忆仓库的端口。业务代码只认这个接口，所以两种实现跑的是同一份逻辑：
 * 内存版（默认）余弦相似度全表排序，MOCK=1 下零外部服务；pgvector 版走 HNSW + `<=>`。
 */
export interface Store {
  init(): Promise<void>
  insert(rows: MemoryRow[]): Promise<void>
  search(userId: string, embedding: number[], limit: number): Promise<SearchHit[]>
  close(): Promise<void>
}

/** 唯一的选择点：有 DATABASE_URL 就走真的 pgvector，否则走内存实现。 */
export function createStore(): Store {
  const url = process.env.DATABASE_URL
  return url ? createPgStore(url) : createMemoryStore()
}

export function storeKind(): string {
  return process.env.DATABASE_URL ? 'pgvector（真实 Postgres）' : '内存实现（全表扫描）'
}
