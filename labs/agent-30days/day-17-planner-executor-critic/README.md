# D17 实验：任务拆分并行 + 评审重写循环

> 目标：在 D15 那张图上加三个角色——Planner 把一句请求拆成 2–3 件子任务写进共享工作区，
> 若干个 Executor 并行把它们做完（每件受 5 次工具调用的预算约束），Critic 逐条验收、
> 不合格就带着具体理由打回重做、最多打回 2 次。做完你能亲眼看见本周最容易踩的那个坑：
> 同一张图、同一份节点代码，只把 `workspace` 通道的 reducer 从 concat 换成按 id 原地更新，
> 工作区就从「6 条记录、3 个重复 id、按 id 查到的是过期版本」变成「3 条、每条都是最新」。

## 你会学到

- 实现 Planner 节点，把一个任务拆成 2-3 个子任务写入共享工作区
- 实现 Executor 并行执行这些子任务，每个子任务受 toolBudget 限制
- 实现 Critic 节点检查 Executor 的输出是否合格
- 不合格时打回 Executor 重写，加最大重试次数防止死循环
- 跑一次完整流程，打印每一步的中间状态

## 目录

- `starter/`：挖了 4 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案

两个变体的 `src/` 结构相同，业务代码只写了一遍：

```text
src/index.ts            入口：SELFTEST 五项自检剧本 / 裸跑演示
src/graph.ts            图状态（两种 reducer 各编译一张图）+ 四个节点 + Send 扇出 + 评审回边 + 逐节点 trace
src/shared/state.ts     W3 共享状态类型：来自 D15，本天不改
src/shared/reducers.ts  concat 与按 id upsert 两个 reducer，以及重复 id 的检测
src/shared/roles.ts     三个角色的业务逻辑：拆解、带预算的执行、按验收要求评审
src/infra/model.ts      唯一的网络出口，MOCK=1 时按 intent 走离线实现
src/infra/orders.ts     子任务用到的工具（内存实现的订单系统，真实环境是一组 HTTP 客户端）
```

`src/shared/state.ts` 原样来自 D15，字段一个没加：今天用到的 `workspace`、`reviewRounds`、
`degraded` 三个字段在 D15 就已经占好位子了。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 就一直用 MOCK=1

# 验收入口：跑完五项自检后退出，全 ✅ 时退出码 0
MOCK=1 SELFTEST=1 pnpm start

# 裸跑演示：拆解 → 并行执行 → 评审 → 汇总，逐节点打印状态变化
MOCK=1 pnpm start
MOCK=1 pnpm start "订单 SO20260902 我要退款，顺便查下物流"

# 接真模型（同一份图代码，只是 src/infra/model.ts 走网络分支）
SELFTEST=1 pnpm start
```

`MOCK=1` 下**零外部服务**：不需要 Redis、不需要 Postgres、不需要 Docker、不需要 API key。
今天没有基础设施依赖，所以本 lab 也没有 `docker-compose.yml`——拆解、并行、评审回路全在进程内。
唯一的网络出口是模型调用（拆解、润色结论、评审三种用途共用一个函数），
它在 `MOCK=1` 下的回复**随输入变化**：换订单号会换出不同的物流与金额，
被 Critic 打回之后执行者的产出也会跟着变——所以离线也能看出状态真的被算过。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 五项自检全部 ✅、退出码 0（`starter/` 原样跑是 1 ✅ 4 ❌，每个 ❌ 点名对应哪个练习）。
2. 第 1、2 项是同一组对照：`workspace` 配 concat reducer 时 3 件子任务留下 6 条记录、3 个重复 id，按 id 查到的第一条是过期的 `pending` 版本；同一张图只把 reducer 换成按 id 原地更新，就变成 3 条、0 个重复、全部 `done`。同时能看到并发峰值是 2 而不是 3。
3. 第 3 项：开票子任务需要 7 次工具调用，撞上 5 次预算后**降级**——`toolCalls` 停在 5、状态 `failed`、`degraded` 为 true、结果里带着已经查到的部分，进程没有抛错；同一轮的物流子任务照常 `done`。
4. 第 4 项：退款方案被打回 1 次后补上「退款结论」通过（`reviewRounds` 为 1、`degraded` 为 false，同一轮的物流子任务没有被连坐重跑）；投诉工单永远给不出工单号，被打回 2 次、共执行 3 次后停下，返回已有结果并置 `degraded` 为 true。
5. 第 5 项：理赔服务 503 时，理赔子任务 `failed`、物流子任务照样 `done`、整张图没有 reject。

## 常见坑

1. **不配 reducer 的症状是「结果对但状态脏」，不是报错。** concat 通道下并行写完，工作区里同一个 id 有 pending 和 done 两份，`workspace.find(t => t.id === id)` 拿到的是先写进去的那一份——也就是过期的。它不抛异常、日志也正常，只在你按 id 读的时候悄悄给错值。要么在 reducer 里解决一次，要么在每一处读取点手动去重（本 lab 的 `latestById` 就是这笔债）。
2. **预算耗尽不要抛错。** 抛错等于把「这件事做了一半」升级成「整个请求失败」，用户连已经查到的物流信息都拿不到。正确做法是把已有结果写进 `result`、状态标 `failed`、置 `degraded`，让上层决定怎么说这句话。
3. **打回一定要带具体理由。** Critic 只回一句「不合格」，执行者拿不到可执行的信息，第二次会原样再交一遍，于是必然打满上限。理由要写成「产出里没有写明退款结论，请补上」这种能直接照着改的句子。
4. **并行的两笔账都要自己记。** Send 扇出的每个 Executor 都是图里的一个节点，任何一个抛错都会让整张图 reject，同一轮里已经做完的活跟着一起丢——异常必须在节点边界被翻译成状态；`maxConcurrency` 不填时，Planner 拆出几件就同时打出几个模型请求，拆 3 件看不出问题，等模型哪天帮你拆出 20 件，你会先收到 429。
