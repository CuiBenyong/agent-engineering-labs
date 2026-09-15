# D13 实验：cron 工具 + 成本台账 + 简易 admin 页

> 目标：写一个中心化的 cron 调度器，让它把定时任务投递进消息总线由 Worker 执行，并用 D8 那条
> `runs.idempotency_key` 唯一约束保证同一个触发点只被执行一次；同时把每次模型调用的 token
> 用量按当前价格换算成美元写进台账，最后用一个脚本按用户汇总当月成本。做完你就能回答
> 「多副本部署时定时任务为什么会被跑 N 次」和「这个月的钱花在谁身上」这两个生产问题。

## 你会学到

- 写一个中心调度器，按 cron 表达式定时往消息总线投递一条任务消息
- worker 消费任务消息并执行一次示例 Agent 调用
- 记录每次调用的 token 用量并按当前价格换算成美元写入台账表
- 写一个简单的 admin 脚本，按用户汇总当月成本
- 验证同一个 cron 任务不会被多个 worker 重复执行

## 目录

- `starter/`：挖了 4 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `docker-compose.yml`：本 lab 自己的 Redis 与 Postgres，只有跑真实版才需要

两个变体的 `src/` 结构相同，业务代码只写了一遍：

```text
src/index.ts        入口：自检 / 常驻 / 报表三种模式
src/scheduler.ts    可注入时钟 + cron 表达式匹配 + 幂等键 + 投递
src/worker.ts       唯一的两个网络出口（chat / embedding）+ 消费循环 + 记账
src/ledger.ts       价格表、token → 微美元换算、按用户汇总、报表渲染
src/infra/index.ts  Bus / Store 接口 + 内存实现 + 唯一的选择点
src/infra/real.ts   ioredis + pg 的真实实现（消费组语义来自 D9，三张表来自 D8，本天不改）
```

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace

# 验收入口：起一个调度器 + 两个 Worker，用快进时钟把 15 分钟跑完，逐项打印 ✅/❌ 后退出
MOCK=1 SELFTEST=1 pnpm start

# admin 脚本：按用户汇总当月成本，打印一张表
MOCK=1 pnpm report

# 常驻模式：调度器每分钟醒来一次 + 一个 Worker 消费（Ctrl-C 退出）
MOCK=1 pnpm start
MOCK=1 WORKER_ID=w-2 pnpm start:worker   # 另开一个终端，手动复现两个 Worker 分工
```

`MOCK=1` 下**零外部服务**：不需要 Redis、不需要 Postgres、不需要 Docker、不需要 API key。
Redis 与 Postgres 走的是 `src/infra/index.ts` 里的内存实现（不是打桩——消费组语义和
`runs.idempotency_key` 唯一约束都真的实现了一遍），时钟是可注入的假时钟，所以自检
一秒内就能把 15 分钟走完，你不用真等一分钟。

想跑真实版：

```bash
docker compose up -d   # 在本 lab 根目录，起 redis:7-alpine 与 pgvector/pgvector:pg16
cd solution
REDIS_URL=redis://127.0.0.1:6513 \
DATABASE_URL=postgres://koda:koda@127.0.0.1:5513/koda \
MOCK=1 SELFTEST=1 pnpm start          # 同一份业务代码，基础设施那一行会打印 real
docker compose down -v                # 收工
```

去掉 `MOCK=1` 并在 `.env` 里填 `OPENROUTER_API_KEY`，走的就是真模型和真 embedding 接口
（这时候台账里的 token 数来自厂商返回的 `usage` 字段，金额不再是自检里那几个整数）。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 五项自检全部 ✅，退出码为 0（`starter/` 原样跑只有第 3 项 ✅）。
2. 第 1 项证明 cron 匹配正确：在 08:58 到 09:12 这 15 分钟里，`*/5 * * * *` 命中 3 次、`0 9 * * *` 命中 1 次。
3. 第 2 项证明幂等：把这 15 分钟重放两遍、共投递 8 条消息，只有 4 条真的被执行，另外 4 条被幂等键挡下。
4. 第 3 项证明同一个 cron tick 只被消费一次：两个 Worker 一起消费，每个 run 恰好留下 2 条台账（1 chat + 1 embedding）。
5. 第 4、5 项证明台账算对：8 条台账合计 0.001328 美元；`pnpm report` 打印出 u-1 为 0.000996、u-2 为 0.000332。

## 常见坑

- **幂等键锚错了时刻。** 用 `Date.now()` 拼键是最常见的写法，也是最难发现的错：单进程跑
  完全正常，一上多实例就失效，因为两个调度器的醒来时刻永远差几百毫秒。键必须锚在
  「计划触发的那一分钟」——把秒和毫秒截掉之后的时间戳。
- **`run_id` 要能从幂等键推出来。** 如果 run 的主键是随机 UUID，`idempotency_key` 唯一约束挡住了
  重复，主键却每次都不同，`on conflict (idempotency_key) do nothing` 会返回 0 行而你以为是别的问题。
  本实验的做法是把幂等键规范化成 run id。
- **金额别用浮点累加。** `0.15 / 1e6` 在二进制浮点里是无限循环小数，几十万条累加之后总额和
  逐条相加对不上。本实验一律用「微美元」整数算和存，最后一步才格式化成 6 位小数
  （Python 用 `Decimal`、Java 用 `BigDecimal` 解决的是同一个问题）。
- **cron 的星期从 0 开始且 0 是周日。** JS 的 `getUTCDay()` 正好一致，但 Python 的 `weekday()`
  周一是 0、Java 的 `DayOfWeek` 周一是 1，换语言实现时这一位最容易错，而且错了要等到下周
  才会被发现。
- **报表默认月份和数据月份要对上。** 自检用的是 2026-09 这个固定月份；如果你把 `MONTH`
  环境变量指到当前月，内存模式下会汇总出 0 条，看起来像汇总逻辑坏了。
