# D11 实验：完整聊天往返 + 打断合并

> 目标：把 D8–D10 拆开的三段接回用户。给每次执行建一个带状态机的 run，让 Worker 生成的片段带着
> `runId + seq` 走一条输出流回到 Gateway，再由 Gateway 按 seq 顺序推给还挂着的 SSE 连接。
> 做完这一步，「用户发一句话 → 看到逐字回复 → 断网重连能续上 → 三秒后改主意能被并进同一次回答」
> 这条链路才第一次真正通了——而这正是拆分架构之后最容易做丢的那部分体验。

## 你会学到

- 定义 run 的状态机与状态转换函数
- 实现 worker 侧把输出片段按 runId、序号写回，gateway 侧按序推给 SSE
- 起一次完整的用户输入 → run 创建 → 流式回传 → run 完成的往返
- 模拟用户在 30 秒内连续发两条消息，验证被合并成一次输入
- 模拟客户端断线重连，验证能从正确的位置继续接收输出

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `docker-compose.yml`：真实版要用的 Redis 与 Postgres（`MOCK=1` 用不上）

两边的 `src/` 结构一样，只有四处核心函数不同：

```text
src/
├── index.ts          启动 gateway + worker，SELFTEST=1 时跑六项自检
├── gateway.ts        POST /chat（建 run 或合并）、GET /runs/:id/stream（SSE）
├── worker.ts         消费 koda:runs，生成片段，双写「库 + 输出流」
├── shared/run.ts     run 类型、状态转换表、打断合并判据      ← 练习 1、4 在这里
├── shared/net.ts     SSE 响应头与分帧、Last-Event-ID、保序器  ← 练习 2、3 在这里
└── infra/            bus.ts（Redis Streams / 内存）、store.ts（Postgres / 内存）
```

`infra/` 里的两个端口各有一份内存实现和一份真实实现，由环境变量选，**业务代码只有一份**。
`bus.ts` 的消费组部分是 D9 的最小版本、`store.ts` 的三张表 schema 是 D8 定稿的，本天都不改。

## 怎么跑

**这个实验是常驻服务，不是跑完就退出的脚本。** 所以照 D7 的规矩，它有两种跑法：

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 就一直用 MOCK=1

# 跑法一（验收命令）：自检模式。起来之后自己给自己发请求，逐项打印 ✅/❌ 再退出
MOCK=1 SELFTEST=1 pnpm start

# 跑法二：常驻，另开终端手动验证（Ctrl+C 停）
MOCK=1 pnpm start
curl -s -X POST http://127.0.0.1:3011/chat \
  -H 'Content-Type: application/json' -d '{"sessionId":"demo","message":"我的订单到哪了"}'
# 拿到 runId 之后订阅它的输出流；-N 是关掉 curl 自己的缓冲，不加会看成一次性刷屏
curl -N http://127.0.0.1:3011/runs/<runId>/stream
# 模拟重连：带上你最后收到的那一号
curl -N -H 'Last-Event-ID: 5' http://127.0.0.1:3011/runs/<runId>/stream
```

`MOCK=1` 下不需要任何 key、不需要 Redis、不需要 Postgres：模型调用会返回一段假回复（每个字隔
10 毫秒），基础设施走内存实现。**状态机、保序、重连、合并这些当天要学的逻辑在离线状态下全都真实执行。**

真实版（同一份业务代码，只换 `infra/` 里的实现）：

```bash
docker compose up -d          # 在 labs/agent-30days/day-11-run-state-machine/ 下执行
cd solution
REDIS_URL=redis://127.0.0.1:6511 \
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5511/day11 \
MOCK=1 SELFTEST=1 pnpm start  # 六项自检结果应当和内存版完全一致
```

想开两个终端手动看 Worker 与 Gateway 分开跑，用 `pnpm start:worker`（读 `WORKER_ID` 环境变量）。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 的**六项自检全是 ✅**。`starter/` 原样跑是
   **第 3、6 项 ✅，第 1、2、4、5 项 ❌**，四个练习点各对应一项，先跑一次记住这个样子。
2. 第 2 项的 seq 前 12 号是 `0,1,2,3,4,5,6,7,8,9,10,11`，拼回来的回复是通顺的一句话；
   `starter/` 会看到 `0,1,2,3,5,4,…` 和一句被打乱的话（「已收到「的我订单到了哪」」）。
3. 第 4 项显示「断开前收到 6 个（最后一号 5），重连后第一号 6，合起来无重复=true、无缺号=true」——
   **不丢也不重**，这两件事要同时成立。
4. 第 5 项显示「第二条 merged=true，仍是同一个 run=true，输出提到「换货」=true，seq 仍连续=true」，
   并且日志里有一行 `[worker worker-1] run 被打断合并，带合并后的输入重跑，seq 从 N 继续`。
5. `pnpm typecheck` 通过、没有 `any`；`docker compose up -d` 之后带上 `REDIS_URL` 与
   `DATABASE_URL` 再跑一次同一条自检命令，六项结果与内存版完全一致。

## 常见坑

- **Last-Event-ID 直接当起始号用**：客户端带回来的是它**最后收到**的那一号，不是它想要的下一号。
  少一个 `+1`，重连后的第一帧就是重复的；多加一个，用户会丢掉一个字。这是重连逻辑唯一的、
  也是最容易写错的一行。
- **保序器忘了丢弃「小于当前指针」的片段**：重连时库里的回放和输出流上还在飘的片段**必然重叠**，
  没有这一行去重，用户会看到一段话说两遍。幂等回放的全部秘密就是这一个比较。
- **打断合并之后把 seq 重置成 0**：同一个 run 跑第二遍时编号必须接着往上加。一旦重置，
  重连时按 `Last-Event-ID` 续号会续到一段已经作废的历史上，现象是「重连后回复从中间开始」。
- **把「需要重跑」写进 runs 表**：这是只在本次执行期间有意义的控制信号。写进业务表，
  进程崩在半路就会留下脏标记，重启后那个 run 会无限重跑。放一个带 TTL 的 Redis 键上，
  进程没了它自己就过期。
- **拿 `request` 的 `close` 当断线信号**（D7 已经踩过一次，Gateway 这边同样适用）：
  Node 里 request 的 `close` 在请求体读完时就触发，要监听的是**响应对象**的 `close`。
