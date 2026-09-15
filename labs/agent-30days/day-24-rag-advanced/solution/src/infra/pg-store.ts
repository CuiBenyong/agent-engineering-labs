import pg from 'pg'

import type { Chunk } from '../corpus'
import { EMBEDDING_DIM } from './model'
import type { Scored, StoredChunk, Store } from './store'

// 真实实现：一张表同时挂两个索引——HNSW 走向量那一路，GIN 走关键词那一路。
// 混合检索不需要第二个数据库，Postgres 一个人就能干这两件事。
//
// terms 列存的是 bigrams() 切好的词项，空格分隔。**中文必须自己切**：Postgres 自带的
// 分词器把一整句中文当成一个 token，直接对 content 建 tsvector 等于没建。
// 生产环境请上 zhparser / pg_jieba 这类中文分词扩展，这里的 bigram 只是不装扩展时的兜底。
const SCHEMA_SQL = `
create extension if not exists vector;
create table if not exists kb_chunks (
  chunk_id     text primary key,
  source_id    text not null,
  source_title text not null,
  content      text not null,
  terms        text not null,
  embedding    vector(${EMBEDDING_DIM}) not null
);
create index if not exists kb_chunks_embedding_idx
  on kb_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists kb_chunks_terms_idx
  on kb_chunks using gin (to_tsvector('simple', terms));
`

const UPSERT_SQL = `insert into kb_chunks (chunk_id, source_id, source_title, content, terms, embedding)
  values ($1, $2, $3, $4, $5, $6::vector) on conflict (chunk_id) do nothing`

const VECTOR_SQL = `select chunk_id, 1 - (embedding <=> $1::vector) as score
  from kb_chunks order by embedding <=> $1::vector limit $2`

// ts_rank 是 Postgres 自带的排序函数，和内存版的 BM25 不是同一个公式，排出来的名次会略有差别。
// 这不影响本天的结论：RRF 融合的是**名次**，两路各自排得合理就够了。
const KEYWORD_SQL = `select chunk_id, ts_rank(to_tsvector('simple', terms), query) as score
  from kb_chunks, to_tsquery('simple', $1) query
  where to_tsvector('simple', terms) @@ query
  order by score desc limit $2`

/** pgvector 收的是 '[0.1,0.2,...]' 这种字面量，不是 Postgres 数组。 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

// tsquery 的词法分析器会把 `sf-3000` 拆成三段，所以入库和查询都先把连字符去掉，
// 让每个词项都是一段干净的 [a-z0-9] 或中文 bigram。两边用同一个函数，才不会一边能查一边查不到。
function tsTerm(term: string): string {
  return term.replace(/[^a-z0-9一-龥]/g, '')
}

export function createPgStore(connectionString: string): Store {
  const pool = new pg.Pool({ connectionString })
  // resolve 只是 id → 正文的查表。真实服务里是一条 `where chunk_id = any($1)`，
  // 这里用一份本地缓存换成同步接口，好让检索管线的代码在两种实现下一模一样。
  const byId = new Map<string, Chunk>()

  return {
    async init() {
      await pool.query(SCHEMA_SQL)
    },
    async upsert(chunks: StoredChunk[]) {
      for (const chunk of chunks) {
        byId.set(chunk.chunkId, chunk)
        await pool.query(UPSERT_SQL, [
          chunk.chunkId,
          chunk.sourceId,
          chunk.sourceTitle,
          chunk.content,
          chunk.terms.map(tsTerm).filter(Boolean).join(' '),
          toVectorLiteral(chunk.embedding),
        ])
      }
    },
    async vectorSearch(embedding, limit) {
      type Row = { chunk_id: string; score: string }
      const res = await pool.query<Row>(VECTOR_SQL, [toVectorLiteral(embedding), limit])
      return res.rows.map((row): Scored => ({ chunkId: row.chunk_id, score: Number(row.score) }))
    },
    async keywordSearch(terms, limit) {
      const query = [...new Set(terms.map(tsTerm).filter(Boolean))].join(' | ')
      if (query.length === 0) return []
      type Row = { chunk_id: string; score: string }
      const res = await pool.query<Row>(KEYWORD_SQL, [query, limit])
      return res.rows.map((row): Scored => ({ chunkId: row.chunk_id, score: Number(row.score) }))
    },
    resolve(chunkIds) {
      return chunkIds
        .map((id) => byId.get(id))
        .filter((chunk): chunk is Chunk => chunk !== undefined)
    },
    size() {
      return byId.size
    },
    async close() {
      await pool.end()
    },
  }
}
