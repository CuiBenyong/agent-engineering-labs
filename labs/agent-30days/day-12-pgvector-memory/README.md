# D12 实验：记忆写入/检索接入 worker

> 目标：给 Agent 装上跨会话的长期记忆——把一段用户档案切块、生成 embedding 存进向量库，
> 再把相似度检索包成一个 `memory_search` 工具接进 Agent 的工具循环，
> 让「换一个 query，命中的记忆跟着变」这件事在你自己的终端里发生一次。

## 你会学到

- 在 Postgres 里装 pgvector 扩展并建一张 memories 表
- 写一个 chunking 函数，把长文本切成若干段
- 为每个 chunk 调用 embedding 接口并写入 memories 表
- 实现相似度检索查询，返回最相关的几条记忆
- 把检索包装成 memory_search 工具，接入 worker 里的 Agent

## 目录

- `starter/`：挖了 4 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `docker-compose.yml`：真实版用的 Postgres（`pgvector/pgvector:pg16`，映射到本机 5512 端口）

两个变体的 `src/` 结构完全一样，业务逻辑只写一遍：

```text
src/
├── index.ts              入口：SELFTEST 自检、单轮提问、假模型与真模型的对话出口
├── memory.ts             chunking + 写入流程 + 检索（练习 1）
├── tool.ts               memory_search 的 schema、参数校验、返回格式（练习 3、4）
└── infra/
    ├── embeddings.ts     embedding 网络出口：MOCK=1 打桩，真实走 OpenRouter
    ├── store.ts          Store 接口 + 唯一的实现选择点
    ├── memory-store.ts   内存实现：余弦相似度全表排序（练习 2）
    └── pg-store.ts       真实实现：pgvector + HNSW 索引 + `<=>` 余弦距离
```

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
MOCK=1 SELFTEST=1 pnpm start    # 验收入口：逐项打印 ✅/❌ 后退出
MOCK=1 pnpm start "我有什么忌口"  # 手动问一句，看 Agent 怎么用 memory_search
```

`MOCK=1` 下**零外部服务**：不需要 API key、不需要 Docker、不需要 Postgres。两类外部依赖的处理方式不同：

- **embedding 与对话模型是网络出口，打桩**。假向量是「字符词袋 + 带符号的特征哈希」算出来的，
  确定性且语义可分——共享的字越多相似度越高，所以离线也能看到检索结果随 query 变化。
  它的分辨率很粗（在它眼里「番茄」和「西红柿」毫无关系），只用来看现象，不代表真实检索质量。
- **pgvector 是基础设施，写内存实现**：余弦相似度全表排序，语义与真实版一致，只是不走索引。

想连真的 pgvector：

```bash
docker compose up -d            # 在 labs/agent-30days/day-12-pgvector-memory/ 目录下
cd solution
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5512/agent_memory \
  MOCK=1 SELFTEST=1 pnpm start  # 仍然打桩 embedding，但存储走真的 pgvector
```

跑的是同一份业务代码，差别只在 `src/infra/` 里换了一个 `Store` 实现。去掉 `MOCK=1`
并在 `.env` 里填 `OPENROUTER_API_KEY`，embedding 和对话就都走真实接口。
重复跑真实版会不断往表里追加记忆，想清空就 `docker compose down -v`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 五项自检全部 ✅、退出码为 0；`starter/` 原样跑有 4 项是 ❌。
2. 自检第 1 项显示一段一千多字符的长文被切成多块，每块不超过 400 字符、相邻两块重叠 80 字符。
3. 自检第 3 项用两个不同的 query 各检索一次，打印出的 top-1 是**不同的**两条记忆——这是「检索真的按语义走」的证据。
4. 自检第 4 项显示 `limit: 50` 被拒绝，回给模型的是一条带合法范围和示例的错误文案；`limit` 缺省时返回 5 条以内。
5. `pnpm typecheck` 通过，没有 `any`。

## 常见坑

1. **假向量必须确定性。** 用 `Math.random()` 造假向量的话，同一段文字每次算出来都不一样，
   检索结果随机跳，你会以为是余弦相似度写错了，其实错在打桩那一层。
2. **余弦相似度别忘了除模长。** 只算点积，长文本天然得分高，短记忆永远排在后面；
   写入端归一化过时点积也对，但换一个 embedding 实现就会静默出错。
3. **切块的回退量必须小于块长。** 下一块起点写成 `end - OVERLAP` 时要保证 `start` 一定前进，
   否则块长小于重叠时 `start` 原地不动，循环永远不结束。
4. **`where user_id = ...` 在 HNSW 上是后过滤。** 索引先按向量取候选、再按用户筛，
   筛完可能凑不够 `limit` 条。用户多而每人记忆少时尤其明显，真实环境要放大 `hnsw.ef_search`
   或按用户分区——不是「加了索引就等于全表扫描的结果」。
5. **`MIN_SCORE` 不能拿离线跑出来的值上线。** 阈值只在「同一个 embedding 模型 + 同一种 chunk
   大小」下有意义。`MOCK=1` 的假向量分辨率粗，实测完全无关的 query 也能拿到 0.29 到 0.36，
   这条下限在离线状态下几乎不拦人——所以自检第 5 项验「空结果」用的是换一个没有记忆的用户，
   不是靠低分过滤。真上线要拿两批 query（该命中的 / 该落空的）各跑一遍，把阈值放进两组分数
   分开的那条缝里。
