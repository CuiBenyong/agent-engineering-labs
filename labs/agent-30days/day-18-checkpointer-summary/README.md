# D18 实验：带 checkpointer 的长对话 + 摘要节点

> 目标：给 D17 那张会扇出、会评审的图配上两样东西——一个在历史过长时把早期消息压成摘要的节点，和一个把图的执行状态落到 Postgres 的检查点存储；然后亲手验证「中断一次、换个进程、原样接着跑完」，以及「从中间某一步分叉走出另一条路」。

## 你会学到

- 给图加一个摘要节点，在消息超过阈值时生成摘要替换早期消息
- 接入一个 checkpointer（如内存或简单存储实现）
- 跑一次多轮执行，中途保存 checkpoint
- 模拟进程重启，从 checkpoint 恢复并继续执行到完成
- 在状态里加一个多模态占位字段，验证摘要节点不会误处理它

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `docker-compose.yml`：本实验的 Postgres（宿主端口 **5518**），只有走真实存储时才需要

两个目录的 `src/` 结构一样，只有 4 处函数体不同：

```text
src/
├── index.ts               自检编排（SELFTEST=1 的五项）
├── graph.ts               图状态、五个节点、接线、恢复与分叉      ← 练习 2、3
├── shared/
│   ├── state.ts           来自 D15，本天不改（字段一个没加）
│   ├── summarize.ts       摘要的触发、切口、保真                  ← 练习 1
│   └── compat.ts          老检查点的版本迁移                      ← 练习 4
└── infra/
    ├── model.ts           唯一的网络出口，MOCK=1 下离线
    └── checkpoints.ts     检查点端口 + 内存版 + Postgres 版
```

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 先用 MOCK=1

MOCK=1 SELFTEST=1 pnpm start   # 五项自检，跑完退出（这是验收入口）
MOCK=1 pnpm start "订单 SO20260901 我要退款"   # 单次演示
```

走真实 Postgres（跑的是同一份图、同一份自检）：

```bash
docker compose up -d          # 在 lab 根目录，Postgres 映射到宿主 5518
cd solution
DATABASE_URL=postgres://agent:agent@localhost:5518/agent_d18 MOCK=1 SELFTEST=1 pnpm start
docker compose exec postgres psql -U agent -d agent_d18 \
  -c "select thread_id, left(checkpoint_id,8), pg_column_size(state) from graph_checkpoints order by 1,2;"
```

两条路的自检结果必须一致——不同的只有 `src/infra/checkpoints.ts` 里选了哪个实现。
`MOCK=1` 只影响模型调用；检查点走内存还是 Postgres，由 `DATABASE_URL` 有没有设决定。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 五项自检全部 ✅、退出码 0（`starter/` 原样跑是 1 ✅ 4 ❌，每个 ❌ 点名对应哪个练习）。
2. 第 1 项：23 条历史进图，出来是「最近 6 条原文逐字未改 + 1 段摘要」，摘要里带着 `#序号(角色)`；另一条线只有 17 条但估算超过 8000 token，同样触发；两条线的 `attachments` 全程一件不少、一个字段没改。
3. 第 2 项：图在 `executor` 之前中断，重新拿一次存储句柄并重建图对象（模拟进程重启）后读到的状态与中断那一刻完全一致；`resumeRun` 跑完剩下的部分，历史只多出那一条回复，恢复阶段的模型调用次数正好等于待执行的子任务数。
4. 第 3 项：中断点检查点的 `__pregel_tasks` 通道里能看到 3 个完整序列化的 `Send`，每个都带着 `node` 和 `args.task`。
5. 第 4、5 项：从 `planner` 之前的同一个检查点带另一句话分叉，拆出的子任务与主线不同且不含主线的那件，原检查点仍能原样读回；一份 v1 形状的老检查点在不迁移时静默读出 `"undefined"` 与 `NaN`，迁移之后两者都正常。

## 常见坑

1. **累加通道压不短。** `messages` 在 D15/D17 配的是 concat reducer，摘要节点返回一个短数组只会被接在后面、越接越长。要让 reducer 认一个「整份替换」的写入指令（本实验用 `{ replace: [...] }`），存储类型和写入类型可以不一样。
2. **恢复时又把历史喂了一遍。** 恢复的入口是 `invoke(null, config)`。带着输入去 invoke 一个中断中的线，它会把输入当成一次新的状态更新叠在中断点上——程序不报错，只是历史变成了两份。练习 2 就是这个现场。
3. **分叉忘了带 `checkpoint_id`。** 只给 `thread_id` 拿到的是这条线**最新**的状态，于是「从第 2 步重来」变成了「在第 6 步后面接着写」。它同样不报错，只有对比子任务列表时才看得出来。
4. **拿 `JSON.stringify` 比对状态，在 Postgres 上会假红。** jsonb 不保存键序（会重排键、去重、去空白），同一份状态从内存版和从 jsonb 读回来的字节序列不同。检查点的等价性判断要用键序无关的规范化比较——`src/index.ts` 里的 `canonical()` 就是干这个的。
5. **检查点是持久的，自检要先清场。** 线程 id 写死时，第二次跑会接着上一轮的状态往下长，断言全线崩。`src/index.ts` 开头对用到的每条线调了一次 `deleteThread`。
