# D2 实验：把一批文本向量化后存入 pgvector 并按余弦距离查最近邻的可复跑脚本

> 目标：把 D1 那份语料换一只眼睛看——每篇文档变成一个 384 或 1536 维的向量存进 pgvector，
> 用余弦距离查最近邻，再把结果和 D1 的 BM25 并排打印。
> 做完你手里就有了全课统一的 `embed()` 接口和一张能查最近邻的表，后面十二天都建在它上面。

## 你会学到

- 用 Docker 起一个带 pgvector 扩展的 PostgreSQL，建出文档表与向量列
- 把第一天的语料逐条向量化写入，离线模式下用确定性的哈希向量代替接口调用
- 按余弦距离查最近邻，把结果跟第一天的 BM25 结果并排打印做对比
- 故意查一个换了说法但意思相同的问题，观察两种检索谁能命中
- 对同一份数据分别用全精度与半精度存一次，比较占用空间与检索结果差异

## 目录

```
day-02-pgvector-nearest-neighbor/
├── corpus/              30 篇「云梯科技」语料，与 D1 完全相同的一份副本
├── docker-compose.yml   pgvector/pgvector:pg16，宿主端口 5552
├── starter/             挖了 4 个练习点的起始代码，MOCK=1 下可以直接跑
└── solution/            参考答案
```

源码六个文件，`starter/` 与 `solution/` 一一对应：

| 文件              | 干什么用                                                    |
| ----------------- | ----------------------------------------------------------- |
| `src/corpus.ts`   | 读 `corpus/*.md`，解析 frontmatter（**来自 D1，本天不改**） |
| `src/tokenize.ts` | 中英混合分词（**来自 D1，本天不改**）                       |
| `src/bm25.ts`     | 倒排索引与 BM25 打分，用来做对照（**来自 D1，本天不改**）   |
| `src/embed.ts`    | 全课统一的 `embed()` 接口与三个后端（**练习 1、2**）        |
| `src/store.ts`    | 向量库接口 + 内存实现 + pgvector 实现（**练习 3、4**）      |
| `src/index.ts`    | 命令行入口：向量化、写库、两路检索并排打印、精度与查询计划  |

`corpus/` 是每个 lab 自带的副本，不跨目录引用别的天——每个目录都要能单独安装、单独跑。

## 全课统一的 embedding 接口

后面十二天照抄这个签名，不要改名：

```
embed(texts: string[], opts?: { dimensions?: number }): Promise<number[][]>
```

三个后端在同一个接口下切换，业务代码一行都不用改：

| 怎么选                | 用什么                                                          |
| --------------------- | --------------------------------------------------------------- |
| `MOCK=1`              | 确定性哈希向量，384 维，不联网不连库                            |
| `EMBED_BACKEND=local` | `@xenova/transformers` + `Xenova/multilingual-e5-small`         |
| 默认                  | OpenAI `text-embedding-3-small`，1536 维，可用 `EMBED_DIM` 降维 |

返回的向量**一律 L2 归一化**。归一化之后余弦相似度等于内积，`<=>` 和 `<#>` 排出来的名次一致，
少掉一整类「距离算错了」的 bug。

> 本地后端要的 `@xenova/transformers` 体量较大（要拉 onnxruntime），没有写进 `dependencies`。
> 想试的话先 `pnpm add @xenova/transformers@2.17.2`，不装也不影响另外两个后端。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env

# ① 完全离线：哈希向量 + 内存向量库，不需要 Docker、不需要 key
MOCK=1 pnpm start
MOCK=1 pnpm start "回收站能保留多久"

# ② 真数据库 + 哈希向量：没有 API key 也能玩 pgvector（推荐先走这一步）
docker compose up -d          # 在 lab 根目录执行，端口 5552
EMBED_BACKEND=mock DATABASE_URL=postgres://rag:rag@localhost:5552/rag pnpm start

# ③ 真数据库 + 真 embedding：.env 里填好 OPENAI_API_KEY 与 DATABASE_URL
pnpm start
EMBED_DIM=512 pnpm start      # 套娃式表示降维，看看名次变不变
```

> `pnpm install --ignore-workspace` 可能以非 0 退出并打印 `[ERR_PNPM_IGNORED_BUILDS]`，
> 这只是 pnpm 拦了 esbuild 的构建脚本，依赖已经装好了。以 `pnpm typecheck` 和 `pnpm start` 的结果为准。

### MOCK 说明

`MOCK=1` 换掉两样东西：embedding 接口换成**确定性哈希向量**，pgvector 换成**内存数组 + 全表扫描**。
业务代码（向量化、写入、查最近邻、排序、精度对比）全都真实执行，两种向量库的名次语义完全一致。

哈希向量的规格（全课 14 天共用同一套，各 lab 自带一份实现）：

1. 文本转小写、去掉全部空白，按 Unicode 字符切成相邻 2-gram（中文按字，英文按字母）。
2. 每个 2-gram 取 UTF-8 字节做 FNV-1a 32 位哈希：对维度取模得到下标，最高位决定符号（0 为 +1，1 为 -1）。
3. 累加进向量，最后 L2 归一化。默认 384 维。

**这套向量保留的是字面重合度，不是语义。** 所以 mock 模式下向量检索的表现会很像关键词检索，
`v02`（换个说法问同一件事）在 mock 下两路都不太行——那不是代码坏了，是 mock 向量本来就不懂「附件 = 文件」。
一句话记住：**`MOCK=1` 验证的是代码路径，不验证检索效果。** 想看真效果，走上面的第 ③ 种跑法。

### 看查询计划

只有连着真实数据库时，最后一段才会打印查询计划。你会看到这样两组：

```text
  默认        Limit
  默认          ->  Sort
  默认                ->  Seq Scan on chunk_embeddings
  关掉全表扫描   ->  Index Scan using chunk_embeddings_hnsw on chunk_embeddings
```

30 行数据时规划器选全表扫描是**对的**——建了索引不等于一定走索引。
把 `enable_seqscan` 关掉能强制看到 `Index Scan using chunk_embeddings_hnsw`，
说明索引确实建对了、运算符类（`vector_cosine_ops`）和查询里的 `<=>` 也配套。
索引参数怎么调、召回率会掉多少，是 D5 的内容，今天只到「建了个索引，能查」。

## 验收标准

1. `MOCK=1 pnpm start` 能打印出 4 个问题各自的 BM25 前三名与向量前三名，两栏并排，向量那栏的距离互不相同。
2. `v01`（单个文件最大能上传多大）两路的前两名都是 `doc-024` 和 `doc-006`——mock 向量保留字面重合度，所以跟 BM25 高度一致。
3. `v03`（限流超了返回 429 吗）BM25 第一名是 `doc-010` 且分数远高于第二名，向量这一路却把 `doc-006` 排到了第一——精确匹配是向量的弱项，这正是 D9 要做混合检索的理由。
4. 全精度与半精度那一段：半精度占用正好是全精度的一半左右，前三名顺序完全一致，距离偏差在小数点后第五位以后。
5. 起了 `docker compose` 之后用 `EMBED_BACKEND=mock DATABASE_URL=…` 再跑一遍，最后能看到查询计划的两组输出：默认是 `Seq Scan`，关掉 `enable_seqscan` 后是 `Index Scan using chunk_embeddings_hnsw`。

## 常见坑

1. **忘了归一化就去用内积。** 只要向量没归一化，`<#>`（内积）和 `<=>`（余弦）排出来就是两个不同的名次，
   而且长文档的向量模长普遍更大，内积会系统性地偏向长文档。统一在 `embed()` 出口归一化一次，别指望调用方记得。
2. **索引的运算符类和查询里的运算符不配套。** 建 `vector_l2_ops` 的索引却用 `<=>` 查，索引就是白建的，
   规划器只会全表扫。它不会报错，只会慢——所以要靠 `EXPLAIN` 去看，不能靠感觉。
3. **看到 `Seq Scan` 就以为索引坏了。** 30 行的表，全表扫描本来就比走 HNSW 快，规划器的选择是对的。
   验证索引能不能用，要 `SET enable_seqscan = off` 再看一遍。
4. **同距离时不给决胜键。** 两条向量距离一模一样时（starter 里练习 3 没做完就是这种情况），
   名次取决于扫描顺序，换个环境就变。内存版和 SQL 里都显式按 `chunk_id` 做了次级排序。
5. **建表时把维度写死。** 向量列的维度必须等于 embedding 后端的输出维度，
   换个模型或者用 `EMBED_DIM` 降维之后，表要重建。这里把维度从后端读出来再建表，就是为了避免手改两处。
