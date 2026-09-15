# D16 实验：supervisor + 3 个子 agent

> 目标：把 D15 那条写死的直线改成**由模型在运行时决定走向**的图。用 zod schema 逼模型输出
> `route / confidence / routingReason` 三个字段，再用条件边把这个决策接成真正的分叉；
> 顺手补上两道闸门（枚举校验、置信度阈值 0.6）和一个人工 override 开关。
> 做完你能回答一个线上一定会被问到的问题：「这一单当时为什么被派给了他？」

## 你会学到

- 定义 3 个子 Agent（`order_lookup` / `refund_draft` / `smalltalk`），各自人设独立、互不打架
- 写一个 Supervisor 节点，用 structured output 输出选择哪个子 Agent 及 routingReason
- 用 `addConditionalEdges` 把路由决策接成运行时才确定的边
- 加一个 override 开关，验证可以人工强制路由到指定子 Agent
- 构造一个模糊意图的输入，观察置信度低于 0.6 时的 fallback 策略

## 目录

- `starter/`：挖了 4 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案

两个变体的 `src/` 结构相同，业务代码只写了一遍：

```text
src/index.ts             入口：SELFTEST 五项自检剧本 / 裸跑演示
src/graph.ts             图状态 + supervisor 节点 + 三个子 Agent + 条件边 + 逐节点 trace
src/shared/routing.ts    zod schema、子 Agent 名单、置信度阈值、fallback 与 override 规则
src/shared/state.ts      W3 全周共享的状态类型（来自 D15，本天一个字段都没改）
src/infra/model.ts       唯一的网络出口：结构化路由 / 自由文本路由（对照组）/ 子 Agent 回答
```

`src/shared/state.ts` 与 D15 逐字相同，`src/graph.ts` 里的 `AgentAnnotation` 也照抄 D15，
今天只是第一次真的往 `route` 和 `routingReason` 两个通道里写值。D17 会继续用同一份状态。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 就一直用 MOCK=1

# 验收入口：跑完五项自检后退出，全 ✅ 时退出码 0
MOCK=1 SELFTEST=1 pnpm start

# 裸跑演示：看一句话被派给了谁、为什么
MOCK=1 pnpm start "订单 SO20260902 我想退款"
MOCK=1 OVERRIDE=smalltalk pnpm start "我的订单 SO20260901 到哪了"

# 接真模型（同一份图代码，只是 src/infra/model.ts 走网络分支）
SELFTEST=1 pnpm start
```

`MOCK=1` 下**零外部服务**：不需要 Redis、不需要 Postgres、不需要 Docker、不需要 API key。
今天没有基础设施依赖，所以本 lab 没有 `docker-compose.yml`——Supervisor、子 Agent、
条件边全在进程内。唯一的网络出口是模型调用，它在 `MOCK=1` 下返回**随输入变化**的路由决策：
问物流给 `order_lookup`(0.88)、问退款给 `refund_draft`(0.92)、说「上次那个事」给 0.42 的低置信度、
说「我要投诉」会自造一个不存在的 `complaint_handler`。四种现象都是线上真实发生过的。

练习按 1 → 2 → 3 → 4 的顺序做，前一个没做完后面的自检项也绿不了。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 五项自检全部 ✅、退出码 0（`starter/` 原样跑五项全 ❌，每项点名对应哪个练习）。
2. 第 1 项：三条路由各命中一次——问物流走 `order_lookup`、问退款走 `refund_draft`、寒暄走 `smalltalk`，且三次的 `routingReason` 都非空。
3. 第 2 项：置信度 0.42 的模糊输入落到 `smalltalk`，`routingReason` 以 `fallback:low-confidence(0.42)` 开头并保留模型原判。
4. 第 3 项：模型返回枚举外的 `complaint_handler` 时被挡下，落到 `smalltalk` 且理由是 `fallback:unknown-route(complaint_handler)`。
5. 第 4 项与第 5 项：`OVERRIDE=refund_draft` 能把「查订单」那一单强制改派到 `refund_draft`，理由里同时留着人工指定与模型原判；六次执行都是「实际跑的正是判的那个」，且每次只跑一个子 Agent。

## 常见坑

1. **自由文本路由是静默失败的。** starter 的默认实现让模型用一句话回答「该找谁」，模型其实判对了（「让查订单的同事看一下」），但它说的是人话不是 id，正则匹配不上就落进兜底——日志里只留下一个 `smalltalk`，你看不出它其实判对了。这正是本章要换掉它的原因。
2. **结构化输出不等于不用校验。** `routeStructured` 的返回类型是 `unknown`：模型只承诺给一段 JSON，不承诺给对的 JSON，网关也不保证严格执行 schema。`safeParse` 那一步不能省，否则模型自造的部门名会让图跳到一个不存在的节点，运行时才炸。
3. **override 不要写进图状态。** 它是「这一次执行被人干预了」，不是 Agent 自己的状态。走 `configurable` 传进来，D18 存检查点时才不会把一次性的人工决定当成历史一起恢复。改派时也别丢掉模型的原判——一周后你要能回答「是模型判错了，还是本来就被人改过」。
4. **选择函数里不要调模型。** `selectRoute` 只读状态、只做翻译。把模型调用塞进条件边的选择函数，同一份状态每次会跳到不同的节点，图就没法复现，D18 的重放也对不上。
5. **LangGraph 编译期会拒绝孤儿节点。** 登记了 `refund_draft` 却没有任何边指向它，`compile()` 会直接抛 `UnreachableNodeError`。用条件边时把映射表写全，三个目标一个都别漏。
