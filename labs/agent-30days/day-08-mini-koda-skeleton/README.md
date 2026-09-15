# D8 实验：mini-koda monorepo 骨架 + PG docker + 迁移

> 目标：把 D7 那个「什么都自己扛」的单进程服务从中间劈开——接入层（Gateway）只做鉴权、限流、落库、投递，执行层（Worker）单独一块，会话状态从进程内存搬到 Postgres 的 sessions / runs / messages 三张表。做完这一步，本周后面六天（消息总线、分片与租约、状态机与保序回传、长期记忆、成本台账、多副本部署）才有东西可长。

## 你会学到

- 按 gateway / worker / shared / infra 四层切开一个 Agent 服务，说清每层只干什么
- 用 Drizzle 定义三张表并跑 drizzle-kit generate 产出可进版本库的迁移
- 用「幂等键 + 唯一约束」让同一条消息投递两次只产生一条 run
- 用状态机白名单挡住 done 被推回 running 这类会覆盖用户回复的迁移
- 用 docker compose 起 Postgres，并让健康检查决定「什么时候算能用了」

## 目录

```
docker-compose.yml        Postgres（pgvector/pgvector:pg16）+ pg_isready 健康检查
starter/  solution/
├── drizzle/              drizzle-kit generate 产出的迁移 SQL，进版本库
├── drizzle.config.ts     generate 读的配置
└── src/
    ├── gateway/server.ts     Fastify：GET /health、POST /chat（只落库不执行）
    ├── worker/inspect.ts     今天只做只读查询，证明两段看到同一份状态
    ├── shared/schema.ts      三张表 + run 状态机 + 幂等键（本周的地基，D9 起照抄）
    ├── shared/config.ts      环境变量与存储选择
    ├── infra/store.ts        存储端口（接口）+ transitionRun（业务逻辑只写一遍）
    ├── infra/memory-store.ts 内存实现：MOCK=1 走这条
    ├── infra/pg-store.ts     Postgres 实现：配了 DATABASE_URL 走这条
    └── index.ts              启动 + SELFTEST=1 自检
```

**为什么不是 pnpm workspace？** 正文说「生产里 gateway / worker / shared 是三个独立的包」，
这没错；但每个 lab 都必须能 `pnpm install --ignore-workspace` 独立安装，
在里面再套一层 workspace 会让这条契约失效。分层的教学目的在目录边界上已经达到了。

**两种存储，一份业务代码。** `MOCK=1` 时用的是 `MemoryStore`，它**不是打桩**——
`idempotency_key` 的唯一索引、`unique(run_id, seq)` 的复合唯一索引、状态的条件更新，
这几条**语义**在内存里被真实实现了一遍（用 Map 和 Set 硬写，真实实现靠 B 树索引）。
`gateway/`、`worker/`、`transitionRun` 这些业务代码只有一份，两种存储下跑的是同一段逻辑。

## 怎么跑

这是一个**常驻服务**，`pnpm start` 起来不会自己退出，所以有两种跑法：

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace

# 跑法一（验收命令）：自检模式。启动后自己给自己发几个请求，逐项打印 ✅/❌ 再退出。
# 完全离线：不需要 Docker、不需要 Postgres、不需要任何 API key。
MOCK=1 SELFTEST=1 pnpm start

# 跑法二：常驻服务，另开一个终端用 curl 验证（Ctrl+C 停）
MOCK=1 pnpm start
curl -i -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"demo","message":"我的订单还没发货","clientMessageId":"cm-1"}'
# 同一条命令再跑一次，runId 应该完全一样（幂等生效），HTTP 状态码是 202 不是 200
```

跑真库（同一份业务代码，只换 `src/infra/` 里的实现）：

```bash
docker compose up -d          # 在本目录，不是 starter/solution 里
cp .env.example .env          # DATABASE_URL 已经填好，端口 5508
pnpm db:generate              # 可选：schema 改了才需要重新生成迁移
DATABASE_URL=postgres://koda:koda@127.0.0.1:5508/koda SELFTEST=1 pnpm start
```

迁移在 `PgStore.connect` 里自动执行（`drizzle/` 下按序号跑，记录写进 `__drizzle_migrations`），
所以第一次连库就会把三张表建好。想亲眼看看约束：

```bash
docker exec -it day-08-mini-koda-skeleton-postgres-1 psql -U koda -d koda -c '\d runs'
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 的**六项自检全是 ✅**。`starter/` 原样跑的样子是
   **第 1、2、6 项 ✅，第 3、4、5 项 ❌**（对应四个挖空的练习点）——先跑一次记住它。
2. 第 3 项：同一个 `clientMessageId` 连发两次，两次返回的 `runId` **相同**，
   该会话下 `runs` 只有 **1 条**——不是 2 条。
3. 第 4 项：`pending` 迁到 `running` 被放行；`done` 迁回 `running` 被拒绝并抛
   `IllegalTransitionError`，run 的最终状态仍是 `done`。
4. 第 5 项：同一个 `runId` 重复写入 `seq` 为 0 的消息被挡下，`messages` 仍只有 **1 条**。
5. 第 6 项：Worker 侧的只读查询看到 Gateway 刚落库的那条 `pending` run（今天不执行，D9 才执行）；
   `pnpm typecheck` 通过，没有 `any`。

## 常见坑

- **幂等键用了随机值**。`randomUUID()` 每次都不一样，唯一约束永远不会冲突，幂等等于没做。
  键必须**由请求内容决定**：会话 id 加客户端消息 id（没有就退回消息内容）做哈希。
  starter 的练习 1 默认就是这个错法，跑一次自检你会看到两条 run。
- **用「先查后插」代替唯一约束**。单线程测试永远是对的，一上并发就出双份：
  两个 Gateway 实例同时查、同时发现没有、同时插入。两条语句之间的时间窗应用层拦不住。
  **幂等的最终裁判必须是数据库的唯一约束**，应用层的判断只是为了少一次插入尝试。
- **状态机不设白名单**。没有白名单时，一条迟到的重复消息能把已经 `done` 的 run 推回 `running`，
  Worker 再跑一遍，用户眼睁睁看着收到的答案变成另一个答案。终态一律不许再往外走。
- **`depends_on` 不带 `condition: service_healthy`**。容器「启动了」不等于「能用了」，
  Postgres 进程起来之后还要几秒做初始化，这几秒里连上去只有拒绝连接——
  本机跑十次挂三次，CI 里更随机。compose 里的 `pg_isready` 就是为这件事。
- **端口占用**。`5508` 是为了避开课程主仓库的 `5433` 和其他几天实验用的端口；
  自检模式默认监听端口 0（内核随机分配），所以不会和本机的 3000 撞车。
- **迁移用「直接同步」而不是生成文件**。drizzle-kit 的 push 在本地玩玩可以，
  生产上没有可回放的历史、没有 review 的时机、也说不清线上那台库停在哪一版。
  **迁移是一条有序的链，不是一次快照。**

## 边界说明

- `POST /chat` **只落库不执行**，这是故意的。第四件事「投递到消息总线」今天是一句注释，
  D9 用 Redis Streams 把它接上，那时候 Worker 才有真正的消费循环。
- Worker 今天只做**只读**查询，而且是轮询——空转浪费、延迟等于轮询间隔、
  多个 Worker 会捞到同一条。这三个问题正是 D9 引入消息总线要解决的。
- 业务场景是通用的电商客服/订单，与 D4–D7 一致；三张表的字段就是课程约定的那几列，
  没有任何真实系统的表结构。
- **有意思的对照**：把 `starter/` 接到真库上跑（去掉 `MOCK=1`、给 `DATABASE_URL`），
  练习 4 那一项会**自动变绿**——因为 `unique(run_id, seq)` 由 Postgres 把关，
  内存版才需要你亲手写出来。练习 1、3 仍然是 ❌，因为幂等键和状态机白名单是业务代码，
  换存储救不了。这恰好说明了为什么「幂等的最终裁判是数据库的唯一约束」，
  以及为什么「状态机必须自己显式写」——两件事不能互相替代。
