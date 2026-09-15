import postgres from 'postgres'
import { toSql } from 'pgvector'
import type { Chunk } from './dataset.js'

export type Sql = postgres.Sql

export const DEFAULT_DATABASE_URL = 'postgres://rag:rag@localhost:5555/rag05'

/**
 * 本天的实验没有「内存实现」这个选项：要量的就是 PostgreSQL 的索引本身。
 * 所以连不上库时不要硬跑，打印怎么起库然后干净退出。
 */
export async function connect(): Promise<Sql | null> {
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const sql = postgres(url, { max: 4, onnotice: () => {} })
  try {
    await sql`select 1`
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => {})
    console.error(`\n连不上 PostgreSQL：${url}`)
    const code = (error as { code?: string }).code
    const message = error instanceof Error ? error.message || error.name : String(error)
    console.error(`${message}${code ? `（${code}）` : ''}`)
    console.error('\n本实验必须有一个带 pgvector 的 PostgreSQL。在 lab 根目录执行：')
    console.error('  docker compose up -d')
    console.error('等健康检查通过后再跑一次。要连别的库就设置 DATABASE_URL。\n')
    return null
  }
  return sql
}

export async function ensureSchema(sql: Sql, dimensions: number): Promise<void> {
  await sql`create extension if not exists vector`
  await sql`drop table if exists chunk_embeddings`
  await sql`
    create table chunk_embeddings (
      id bigserial primary key,
      chunk_id text not null,
      doc_id text not null,
      department text not null,
      tenant_id text not null,
      text text not null,
      embedding vector(${sql.unsafe(String(dimensions))}) not null
    )
  `
}

/** 分批插入。向量按文本形式过网，保留 5 位小数就够——距离排序不会因为第 6 位变化 */
export async function loadRows(sql: Sql, rows: Chunk[], vectors: number[][]): Promise<void> {
  const batchSize = 500
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize).map((row, j) => ({
      chunk_id: row.chunkId,
      doc_id: row.docId,
      department: row.department,
      tenant_id: row.tenantId,
      text: row.text,
      embedding: toSql(vectors[i + j].map((v) => Number(v.toFixed(5)))) as string,
    }))
    await sql`insert into chunk_embeddings ${sql(slice)}`
  }
  await sql`analyze chunk_embeddings`
}

export async function tableSize(sql: Sql): Promise<number> {
  const [row] = await sql<{ size: string }[]>`
    select pg_relation_size('chunk_embeddings') as size
  `
  return Number(row.size)
}

export async function indexSize(sql: Sql, name: string): Promise<number> {
  const [row] = await sql<{ size: string }[]>`
    select pg_relation_size(${name}::regclass) as size
  `
  return Number(row.size)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}
