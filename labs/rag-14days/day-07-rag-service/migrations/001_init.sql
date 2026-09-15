-- D7 的建表脚本。三张表的名字是全课统一约定的：documents / chunks / chunk_embeddings。
--
-- 这个文件被挂进容器的 /docker-entrypoint-initdb.d，所以 `docker compose up -d`
-- 第一次起库时会自动执行它——这就是「一条命令起数据库并自动完成迁移」。
-- 但 initdb.d 只在**数据卷为空**时跑，所以服务端的 store.init() 里还有一份等价的
-- 可重复执行版本；两处都写成 IF NOT EXISTS，跑几遍都不会出错。

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  doc_id       text PRIMARY KEY,
  title        text NOT NULL,
  department   text NOT NULL,
  updated_at   date NOT NULL,
  -- 整篇文档的内容指纹。D7 还没做增量同步，但字段先留好：D13 靠它判断哪些文档需要重算
  content_hash text NOT NULL,
  ingested_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id     text PRIMARY KEY,
  doc_id       text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  text         text NOT NULL,
  heading_path text[] NOT NULL DEFAULT '{}',
  page         integer,
  department   text NOT NULL,
  updated_at   date NOT NULL,
  content_hash text NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks (doc_id);

-- 向量单独一张表：换 embedding 模型时只重建这一张，documents / chunks 不动。
-- 维度写死成 384，跟配置里的 embedding.dimensions 对应；改维度是一次迁移 + 全量重算，
-- 怎么不停机地做见 D13。
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id  text PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  model     text NOT NULL,
  embedding vector(384) NOT NULL
);

-- 30 篇语料用不上近似索引（顺序扫更快也更准），但生产上这一行是必需的。
-- 两种索引怎么选、参数怎么调、加了 WHERE 之后为什么会漏召回，见 D5。
CREATE INDEX IF NOT EXISTS chunk_embeddings_hnsw
  ON chunk_embeddings USING hnsw (embedding vector_cosine_ops);
