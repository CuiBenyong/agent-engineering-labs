# D24 实验：记忆检索升级 + 评估

> 目标：把 D12 那一路只有向量的检索升级成「关键词 + 向量 → RRF 融合 → 重排 → 带引用」的完整链路，并用一套 20 条的评估集把 recall@5 从 57% 抬到 91%——**每一步的收益都是算出来的，不是感觉出来的。**

## 你会学到

- 在 D12 的向量检索基础上加一路关键词检索
- 合并两路检索结果，实现一个简单的 rerank 排序
- 在最终回答里带上引用来源的标注
- 构造一批带标准答案的问题，计算 recall 指标
- 对比 hybrid + rerank 前后的 recall 变化

## 目录

- `starter/`：挖了 4 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：完整实现

```text
src/
├── corpus.ts     54 篇电商客服文档、切块（512 字符 / 重叠 64）、20 条评估集
├── retrieve.ts   bigram 分词、RRF 融合、重排、三档检索入口（练习 1-3 在这里）
├── cite.ts       上下文拼接、引用编号、幻觉引用剔除与计数（练习 4 在这里）
├── eval.ts       recall@k 与 MRR
└── infra/        存储端口 + 内存实现 + pgvector 实现；embedding 与重排的模型出口
```

`corpus.ts` 的切块逻辑与 `infra/` 的向量存储来自 **D12，本天不改**，只在旁边加了关键词那一路。

## 怎么跑

```bash
cd starter                       # 或 solution
pnpm install --ignore-workspace  # 打印 ERR_PNPM_IGNORED_BUILDS 并非 0 退出是正常的
MOCK=1 SELFTEST=1 pnpm start     # 五项自检，跑完退出
```

**`MOCK=1` 下零外部服务**：不需要 Postgres、不需要 Docker、不需要 API key。
embedding 由文本内容确定性生成（字符哈希 → 1536 维），所以召回率是真算出来的——
改一条 query 或改一篇文档，数字就会跟着变。

想连真 pgvector：

```bash
docker compose up -d   # 宿主端口 5524
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5524/rag SELFTEST=1 pnpm start
```

跑的是同一份检索代码，只换了 `src/infra/` 里的存储实现。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。装完检查一下有没有多出
> `pnpm-workspace.yaml`，有就删掉。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 五项自检全部 ✅、退出码 0（`starter/` 原样跑是 1/5）。
2. 第 2 项证明两路的盲区不重叠：`E4032` 那条 query 向量 top5 里没有 `s07#0`，而关键词 top1 就是它；中文 query 在 bigram 实现之前关键词那一路一条都召不回。
3. 第 3 项证明 RRF 融合的是名次不是分数：`[a,b,c]` 与 `[c,d,a]` 融合后第一名是 `a`（0.03227）；分数直接相加的版本给出的是 `c`（12.635）。
4. 第 4 项打出三档 recall 的严格递进：recall@5 从 **57%** → **80%** → **91%**，且 recall@20 从 83% → 95% → 98%。
5. 第 5 项证明引用后处理生效：回答里出现的不存在编号被剔除，幻觉引用计数从 0/1 变成 1/1（计进指标而不是原样发出）。

## 常见坑

1. **把 RRF 写成了加权求和。** 只要你在融合函数里还读得到 `score` 字段，就是没写对——RRF 的全部要点是**把两路的分数丢掉，只用名次**。判断方法：把某一路的分数全部乘以 100，融合结果不应该有任何变化。
2. **同分时的顺序没定死。** `[a,b,c]` 与 `[c,d,a]` 里 a 和 c 是同分的，如果不显式加「同分按 id 排」，结果就取决于哈希表的遍历顺序，同一份输入换个语言甚至换次运行都可能不一样，评估集量出来的数字自然也不稳。
3. **bigram 把英文和编号也切碎了。** `e4032` 切成 `e4`、`40`、`03`、`32` 之后，那条 query 就再也命中不了——而这恰恰是关键词那一路唯一的强项。字母数字必须整词保留。
4. **重排接上了但 recall@20 没变，以为没生效。** 那是对的：重排不召回新东西，它只重排已有的 20 条。**要看的是 recall@5 和 MRR**——本实验里它们从 80%／0.732 涨到 91%／0.908。
