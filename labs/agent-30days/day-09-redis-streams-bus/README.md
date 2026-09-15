# D9 实验：gateway 发布 → worker 消费 echo

> 目标：把 D8 停在「落库就结束」的 `POST /chat` 接上最后一步——Gateway 用 `XADD` 把一条 run 投进
> Redis Streams，多个 Worker 用同一个消费组 `workers` 把它捞出来执行、回写 `messages` 表、`XACK` 销号；
> 崩掉的 Worker 手上那条消息由别人 `XAUTOCLAIM` 接手，反复失败的那条搬进 `koda:runs:dead`。
> 做完这一步，D8→D9 的完整链路第一次真的跑通，你手上也第一次有了一个「进程可以随便死」的执行层。

## 你会学到

- 起一个本地 Redis，创建一个 stream 和一个 consumer group
- 写一个 gateway 脚本用 XADD 发布消息
- 写一个 worker 脚本用 XREADGROUP 消费并 XACK
- 模拟 worker 处理中途崩溃，用 XAUTOCLAIM 让另一个 worker 接手
- 让某条消息故意反复失败，验证毒消息隔离逻辑生效

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑（原样跑是 2/5 通过）
- `solution/`：参考答案，`MOCK=1` 下 5/5 全绿
- `docker-compose.yml`：本实验自带的 `redis:7-alpine`，只有想连真 Redis 时才需要

两边 `src/` 的结构相同，业务代码只有一份：

```text
src/
├── index.ts              # 入口：SELFTEST 自检编排 / 常驻 worker
├── gateway/gateway.ts    # 接住 D8 的 POST /chat：先落库，再 XADD
├── worker/worker.ts      # 消费循环：autoClaim → readGroup → 执行 → 回写 → XACK
├── shared/config.ts      # 流名、消费组名、毒消息阈值（W2 全周固定口径）
├── shared/store.ts       # D8 定稿的 runs / messages 两张表（字段照抄，本天不改）
└── infra/                # 端口 + 两个实现，唯一的选择点在 bus.ts 的 createBus
    ├── bus.ts            #   Bus 接口：七个方法一一对应 Redis 命令
    ├── memory-bus.ts     #   内存实现：用一个数组 + 两个 Map 写出 consumer group 语义
    └── redis-bus.ts      #   真实实现：ioredis，直接发 XADD/XREADGROUP/XACK/XAUTOCLAIM
```

`shared/store.ts` 里那两张表来自 D8，本天一列都没改；D8 那边它们在 Postgres 里用 Drizzle 定义，
这里为了让 `MOCK=1` 零外部服务只带一份内存实现，接口是同一个。
**`MOCK=1` 走的不是打桩，是内存实现**：`memory-bus.ts` 把读游标、PEL、投递计数真的写了出来，
所以离线跑到的现象和真 Redis 上一模一样——今天要教的语义本身就在那 110 行里。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace

# 验收命令：起来后自己扮演 gateway 和多个 worker，逐项打 ✅/❌ 再退出
MOCK=1 SELFTEST=1 pnpm start

# 常驻模式：先投三条（其中一条是永远失败的 boom），然后一直消费。Ctrl+C 退出
MOCK=1 pnpm start
```

`.env` 今天用不上：业务处理刻意只做 echo，没有模型调用，所以 `MOCK=1` 下**不需要任何 key**。
把 `worker.ts` 里的 `generateReply` 换成 D4 的模型调用层，链路其余部分一行都不用改。

同一份业务代码换成真 Redis：

```bash
docker compose up -d                                   # 起 redis:7-alpine
cd solution
REDIS_URL=redis://127.0.0.1:6509 SELFTEST=1 pnpm start # 五项自检，这次跑在真 Redis 上
REDIS_URL=redis://127.0.0.1:6509 pnpm start            # 常驻
# 另开一个终端，看两个 worker 怎么分摊同一条流
REDIS_URL=redis://127.0.0.1:6509 WORKER_ID=worker-2 pnpm start:worker
docker compose down                                    # 收工
```

跑真 Redis 时可以顺手用 `redis-cli` 从旁边看：`XLEN koda:runs`、`XINFO GROUPS koda:runs`、
`XPENDING koda:runs workers` 这三条命令能把自检打印的数字对上。
`APP_ENV=dev` 会把流名变成 `dev:koda:runs`，dev 与 prod 共用一台 Redis 时靠它隔离，D14 会用到。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。安装最后打印
> `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild` 并以非 0 退出是正常的，依赖已经装好了。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 五项自检全是 ✅。`starter/` 原样跑是 **第 1、2 项 ✅，第 3、4、5 项 ❌**，
   四个练习点做完才会全绿——先跑一次记住这个数字。
2. 第 2 项显示两个 worker **各自都处理到了消息**（形如 `a=2 b=1`），回复 3 条、`pending 0`：
   同一条流被消费组分摊，`XACK` 之后 pending 归零。
3. 第 3 项显示 `重复提交被挡=true`、`run 3 个`、`回复 3 条`：重复提交被 `runs.idempotency_key`
   的唯一约束挡住，重复投递被 worker 的幂等短路挡住，**至少一次投递没有变成两条回复**。
4. 第 4 项显示 `崩溃后 pending 1，worker-b 接手 1`：worker-a 取走消息没 `XACK` 就"崩了"，
   闲置超过阈值后 `XAUTOCLAIM` 让 worker-b 接手并跑完，`run` 最终是 `done`。
5. 第 5 项显示 `失败 3 次，死信流 1 条，run.status=failed，pending 0`：那条 `boom` 消息
   被投递 3 次都失败后搬进 `koda:runs:dead`，原流的 pending 清空，没有卡住后面的消息。
6. `pnpm typecheck` 通过，没有 `any`。

## 常见坑

1. **先 `XACK` 再干活，等于把 at-least-once 降级成 at-most-once。** `XACK` 一定是处理成功后的
   最后一步；提前销号的话进程一崩这条消息就人间蒸发，PEL 里查不到、`XAUTOCLAIM` 也捡不回来。
2. **`XREADGROUP` 结尾的 `>` 和 `0` 是两个完全不同的命令。** `>` 是「给我从没投递给本组的新消息」，
   `0` 是「重读我自己 pending 里的那些」。写成 `0` 之后新消息永远读不到，程序看起来像是卡死了。
3. **失败了却顺手 `XACK`，毒消息会静默丢失。** 处理失败时正确的动作是**什么都不做**，
   让消息留在 pending 里等人接手；只有投递次数够到阈值（本课固定 3 次）才搬去死信流并 `XACK`。
   反过来，失败后一直不搬走，它会被无限重投，把 worker 的处理能力全占住。
4. **`XAUTOCLAIM` 的 `min-idle-time` 给太小会造成重复执行。** 设成 100 毫秒，一个还在正常
   处理的消息就会被别人抢走，同一个 run 被跑两遍。生产里这个值要大于「正常处理耗时的上限」，
   而消息重复被执行的兜底不是把它调小，是 `runs.idempotency_key` 和 `unique(run_id, seq)` 那两道闸门。
