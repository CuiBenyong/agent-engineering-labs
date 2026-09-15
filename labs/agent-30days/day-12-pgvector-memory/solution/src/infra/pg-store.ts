import pg from 'pg'

import { EMBEDDING_DIM } from './embeddings'
import type { SearchHit, Store } from './store'

// 真实实现：pgvector。表结构与正文里那段 SQL 完全一致。`<=>` 是余弦距离（0 到 2），
// `1 - (a <=> b)` 就是余弦相似度。HNSW 是近似最近邻索引：快，但可能漏掉真正最近的那一条。
const SCHEMA_SQL = `
create extension if not exists vector;
create table if not exists memories (
  id            text primary key,
  user_id       text not null,
  source_run_id text,
  content       text not null,
  embedding     vector(${EMBEDDING_DIM}) not null,
  created_at    timestamptz not null default now()
);
create index if not exists memories_user_id_idx on memories (user_id);
create index if not exists memories_embedding_idx
  on memories using hnsw (embedding vector_cosine_ops);
`

const INSERT_SQL = `insert into memories (id, user_id, source_run_id, content, embedding, created_at)
  values ($1, $2, $3, $4, $5::vector, $6) on conflict (id) do nothing`

// 注意 where 是后过滤：HNSW 先按向量取候选、再按 user_id 筛，
// 用户多而每人记忆少时可能凑不够 limit 条，生产里要放大 hnsw.ef_search 或按用户分区。
const SEARCH_SQL = `select id, content, created_at, 1 - (embedding <=> $2::vector) as score
  from memories where user_id = $1 order by embedding <=> $2::vector limit $3`

/** pgvector 收的是 '[0.1,0.2,...]' 这种字面量，不是 Postgres 数组。 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

export function createPgStore(connectionString: string): Store {
  const pool = new pg.Pool({ connectionString })
  return {
    async init() {
      await pool.query(SCHEMA_SQL)
    },
    async insert(rows) {
      for (const r of rows) {
        const vec = toVectorLiteral(r.embedding)
        await pool.query(INSERT_SQL, [r.id, r.userId, r.sourceRunId, r.content, vec, r.createdAt])
      }
    },
    async search(userId, embedding, limit) {
      type Row = { id: string; content: string; created_at: Date; score: string }
      const args = [userId, toVectorLiteral(embedding), limit]
      const res = await pool.query<Row>(SEARCH_SQL, args)
      return res.rows.map((row): SearchHit => ({
        id: row.id,
        content: row.content,
        createdAt: row.created_at.toISOString(),
        score: Number(row.score),
      }))
    },
    async close() {
      await pool.end()
    },
  }
}
