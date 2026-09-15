# D15 实验：三节点 LangGraph

> 目标：先用代码把五种多 Agent 协作模式的**结构**画出来、把「该不该拆」的三条判据写成一个能
> 跑的函数，再用 LangGraph.js 搭出第一个三节点的图（入口 → 处理 → 输出），
> 逐节点看清状态是怎么在节点之间流动的。做完你能回答两个问题：
> 「这个需求到底该不该上多 Agent」和「图跑了一遍，每个节点各改了状态里的哪几个字段」。

## 你会学到

- 画出 Router/Supervisor、Planner-Executor、Critic 三种模式的结构图，并用扇出/汇合/回边把它们区分开
- 安装 LangGraph.js，定义 W3 全周共用的共享状态类型 `AgentState`
- 搭一个三节点的图：入口节点 → 处理节点 → 输出节点
- 跑通一次完整的图执行并打印每个节点的状态变化

## 目录

- `starter/`：挖了 4 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案

两个变体的 `src/` 结构相同，业务代码只写了一遍：

```text
src/index.ts            入口：SELFTEST 自检剧本 / 裸跑演示
src/graph.ts            AgentAnnotation（图状态）+ 三个节点 + 连边 + 逐节点 trace
src/shared/state.ts     W3 全周共享的状态类型：Message / Attachment / Task / AgentState
src/shared/patterns.ts  五种协作模式的边表、形状分析、ASCII 结构图
src/shared/decide.ts    该不该拆成多 Agent 的三条判据
src/infra/model.ts      唯一的网络出口，MOCK=1 时走离线回复
```

`src/shared/state.ts` 是 **W3 的共享地基**：D16 的路由、D17 的并行子任务、D18 的摘要与检查点
都往同一份 `AgentState` 上写字段，所以后面几天会原样复制这个文件。今天先把字段占好、
把每个字段归谁写注清楚。`Message` 的形状沿用 D2，今天不改。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 就一直用 MOCK=1

# 验收入口：跑完四项自检后退出，全 ✅ 时退出码 0
MOCK=1 SELFTEST=1 pnpm start

# 裸跑演示：打印五种模式的结构图、四个场景的判据结论，再跑一次图
MOCK=1 pnpm start
MOCK=1 pnpm start "订单 SO20260902 我想退款"

# 接真模型（同一份图代码，只是 src/infra/model.ts 走网络分支）
SELFTEST=1 pnpm start
```

`MOCK=1` 下**零外部服务**：不需要 Redis、不需要 Postgres、不需要 Docker、不需要 API key。
今天没有基础设施依赖，所以本 lab 没有 `docker-compose.yml`——图的执行、状态合并、
逐节点 trace 全在进程内，本来就不需要外部服务。唯一的网络出口是模型调用，
它在 `MOCK=1` 下返回**随输入变化**的离线回复：问物流、问退款、问发票会得到三种不同的答案，
所以离线也能看出「状态真的被算过」，而不是打印了一段固定文案。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 四项自检全部 ✅、退出码 0（`starter/` 原样跑四项全 ❌，每项点名对应哪个练习）。
2. 第 1 项：五种模式的形状依次判成分叉、扇出加汇合、分叉加回边、分叉加回边、扇出加汇合加回边，终端上能看到五张 ASCII 结构图，条件边画成虚线。
3. 第 2 项：四个场景判对四个——「查订单 + 查物流的只读助手」判**不拆**，另外三个各命中一条判据判**拆**，并打印命中的是哪一条。
4. 第 3 项：三节点图跑通，工作区里恰好 1 件活是 `done`，末条消息是 assistant 且带着订单号；物流问句和退款问句的回复内容不同。
5. 第 4 项：能打印出 `intake → handle → respond` 三步、每步写了哪几个字段，且 `route` 字段全程没被写入（它按约定留给 D16）。

## 常见坑

1. **漏边和漏登记，报错方式完全不同。** 登记了却不连边，`compile()` 会直接抛 `UnreachableNodeError`（编译期就拦住，是好事）；而**压根没 `addNode`** 就没人救得了你——函数在文件里躺着，图照常跑，只是那一步从来没发生过，日志上看不出异常。starter 的练习 3 是后一种。校验的着力点是「我以为在图里的节点是不是真在图里」，打印 `graph.getGraph().nodes` 比盯代码有用。
2. **在节点里原地改 state 等于白改。** 节点要 `return` 一个只含改动字段的对象，让通道的 reducer 去合并；直接 `state.workspace.push(...)` 绕过了 reducer，并行时会互相覆盖，D18 存检查点时也对不上。
3. **`invoke` 看不到中间过程。** 调试图必须用 `graph.stream(input, { streamMode: 'updates' })`，它在每个节点结束时吐出该节点写的增量。用 `invoke` 排查「为什么这个字段没值」，你只能靠猜。
4. **统计图形状时忘了排除 START 和 END。** START 天然只有一条出边、END 天然收很多入边，不排除的话五种模式会都被判成「有扇出、有汇合」，练习 1 的自检就永远绿不了。
