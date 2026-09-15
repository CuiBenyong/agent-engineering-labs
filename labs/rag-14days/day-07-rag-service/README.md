# D7 实验：一个可用 Docker 一键启动、含摄取命令与带引用问答接口的完整 RAG 服务

> 目标：把前六天散在六个 lab 里的零件——解析、切块、向量化、检索、组装、带引用生成——
> 按一组固定的接口装成一个真正的服务：一条命令起数据库并自动建表，一个接口投喂文档，
> 一个接口提问，一个接口回看引用的原文。这是第一周的里程碑产物，也是第二周每一天要改的那个东西。

## 你会学到

- 把前六天的模块整理成统一的接口并接起来
- 写摄取命令：给一个目录，自动解析、切块、向量化并入库
- 写问答接口：接收问题，返回带引用的回答与用到的块
- 写容器编排文件，确保一条命令能起数据库并自动完成迁移
- 跑一遍端到端自测，把结果与第一天的基线并排记录

## 目录

```
day-07-rag-service/
├── docker-compose.yml    PostgreSQL 16 + pgvector，端口 5557
├── migrations/001_init.sql  三张表 + 扩展 + HNSW 索引，起库时自动执行
├── rag.config.json       全服务唯一的参数面板（starter 与 solution 共用）
├── corpus/               30 篇「云梯科技」语料，与 D1 完全相同的副本
├── baseline-d1.json      D1 跑出来的检索基线，自测时并排对照
├── starter/              挖了 4 个练习点的起始代码
└── solution/             参考答案
```

`starter/src/` 与 `solution/src/` 是同样的八个文件，一一对应：

| 文件          | 属于哪条链路 | 干什么用                                                     |
| ------------- | ------------ | ------------------------------------------------------------ |
| `config.ts`   | 两条都用     | 读 `rag.config.json`，环境变量只做覆盖                       |
| `pipeline.ts` | 摄取         | 解析（D3 的节点结构）与切块（D4 的切块器，**练习 1**）       |
| `embed.ts`    | 摄取 + 查询  | D2 定下的 `embed()` 接口，三个后端（**练习 2**）             |
| `store.ts`    | 两条的交界   | Store 接口 + PostgreSQL 实现 + 内存实现                      |
| `retrieve.ts` | 查询         | 关键词一路（D1 的 BM25）、向量一路、融合与门槛（**练习 3**） |
| `answer.ts`   | 查询         | 上下文组装、带引用生成、引用校验与拒答（D6，**练习 4**）     |
| `ingest.ts`   | 摄取         | 四步的编排，唯一知道「摄取有四步」的地方                     |
| `index.ts`    | 服务         | Fastify 三个接口 + `SELFTEST=1` 自测                         |

模块边界是按**「哪一层要能被单独换掉」**画的，不是按代码量：
换 embedding 模型只动 `embed.ts` 与配置，换切块策略只动 `rag.config.json`，
换存储只动 `store.ts`。两条链路唯一共享的东西是 `store.ts` 的那个接口——
它们不共享任何业务代码，因为摄取是批处理、查询是在线请求，两者的错误处理和
性能约束根本不一样，强行复用只会让两边都别扭。

## 怎么跑

零依赖跑法（不用 Docker、不用 key，五秒钟出结果）：

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
MOCK=1 SELFTEST=1 pnpm start   # 起服务、自己给自己发请求、逐项打印 ✅/❌，跑完退出
MOCK=1 pnpm start              # 常驻，供你手动 curl
```

真实链路（PostgreSQL + pgvector）：

```bash
cd ..                          # 回到 lab 根目录
docker compose up -d           # 起库；第一次启动会自动执行 migrations/001_init.sql
cd solution
cp .env.example .env           # 填 OPENAI_API_KEY / ANTHROPIC_API_KEY，并解开 DATABASE_URL 那一行
DATABASE_URL=postgres://rag:rag@localhost:5557/rag MOCK=1 SELFTEST=1 pnpm start   # 真库 + 假模型
DATABASE_URL=postgres://rag:rag@localhost:5557/rag pnpm start                      # 真库 + 真模型
docker compose down -v         # 用完连数据卷一起删
```

手动试三个接口（服务常驻时）：

```bash
curl -s -X POST localhost:3057/ingest -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:3057/ask -H 'content-type: application/json' \
  -d '{"question":"删掉的文件在回收站里能保留多久？"}'
curl -s "localhost:3057/chunks/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("doc-006#c04"))')"
curl -s localhost:3057/health
```

改配置不改代码（改完重跑自测就能看到差别）：

```bash
CHUNK_STRATEGY=fixed MOCK=1 SELFTEST=1 pnpm start   # 按标题切 134 块 → 定长切 52 块
ROUTES=bm25 MOCK=1 SELFTEST=1 pnpm start            # 只走关键词一路
TOP_K=8 MOCK=1 SELFTEST=1 pnpm start                # 每次多喂几块给模型
```

> `pnpm install --ignore-workspace` 可能以非 0 退出并打印 `[ERR_PNPM_IGNORED_BUILDS]`，
> 这只是 pnpm 拦了 esbuild 的构建脚本，依赖已经装好了。以 `pnpm typecheck` 和自测结果为准。

### MOCK 说明

`MOCK=1` 换掉两个网络出口，其余一行不改：

- **向量化**：换成全课统一的确定性哈希向量（2-gram + FNV-1a + L2 归一化，384 维）。
- **生成**：不调模型，改成从每个命中块里摘一句最相关的、带上块编号列出来。

解析、切块、入库、两路检索、门槛、引用校验、拒答**全都真实执行**。
另外，**没有 `DATABASE_URL` 时存储自动退回内存实现**——它不是打桩，是把
PostgreSQL 那套语义（按文档覆盖旧块、余弦排序、同分按 id 决胜）用 Map 和数组重写了一遍。
所以离线也能看到真实的检索现象。

一件必须记牢的事：**哈希向量保留的是字面重合度，所以 MOCK 下向量这一路的行为接近关键词检索**。
自测最后那行诊断会告诉你「只靠向量进来的块有几个」，在 MOCK 下这个数通常是 0。
**MOCK 验证的是代码路径，不是检索效果。** 想看向量真正的价值，得配上 `OPENAI_API_KEY`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 在 solution 里 **8 项全 ✅**、退出码 0；在原样的 starter 里有 5 项 ❌。
2. 摄取那一项打印「30 篇 → 134 块」，关键词索引的块数与入库块数相等（摄取完索引真的刷新了）。
3. 问「单个文件最大能上传多大」，`doc-006` 与 `doc-024` 两篇结论打架的文档同时进上下文，
   每条引用都能用 `GET /chunks/:chunkId` 点开看到原文。
4. 问「公司每年团建预算是多少」走到拒答；喂给引用校验的两条坏引用都被拦下：
   一条编号越界（`[9]`，本次只发出 `1..k`），一条编号真实但与那句话的实质重合度低于 0.3。
5. 与 `baseline-d1.json` 并排的九行里，拒答判断 9/9 与 D1 一致，但九题里有五题的命中文档
   集合变了——切块之后同一份语料的检索结果确实不一样了，至于是变好还是变坏，今天答不了。
6. `docker compose up -d` 之后加上 `DATABASE_URL` 再跑一遍，八项结果与内存版**完全一致**。

## 常见坑

1. **摄取完忘了重建关键词索引。** BM25 索引在内存里，新入库的块向量能查到、关键词查不到，
   表现出来只是「结果怪怪的」，很难往这上面想。`POST /ingest` 的最后一行就是 `retriever.refresh()`，
   返回体里的 `indexed` 字段专门用来验证这件事。
2. **`chunkId` 里的 `#` 直接拼进 URL。** `doc-006#c04` 的 `#` 会被浏览器和 curl 当成 URL 片段，
   服务端只收到 `doc-006`，然后 404。路径参数必须 `encodeURIComponent`，
   `#` 要变成 `%23`——这是把块编号设计成带 `#` 的形式必须付的税。
3. **把门槛卡在融合分上。** 融合分是按本次查询的最高分归一化出来的，全场最相关的那条哪怕
   只有 3 分，融合分照样是 1.0。拿它当门槛，系统就再也不会拒答了。门槛必须卡在每一路的原始分上。
4. **以为 `docker compose up -d` 总会跑迁移。** `docker-entrypoint-initdb.d` 里的脚本
   **只在数据卷为空时执行一次**。改了 `migrations/001_init.sql` 之后不 `down -v` 就重启，
   新语句一句都不会跑。所以 `store.init()` 里还留着一份可重复执行的等价版本兜底。
5. **`vectorMinCosine` 这个阈值是拍出来的。** 现在的 0.2 是对着 MOCK 的哈希向量量出来的，
   换成真实 embedding 之后分数分布完全不同，必须重新标定——而怎么标定才算「对」，
   要等 D8 有了评估集才有依据。这是这一版明确留下的债之一，不要把它当成一个可信的默认值。
