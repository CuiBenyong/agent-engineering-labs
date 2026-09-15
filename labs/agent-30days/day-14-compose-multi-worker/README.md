# D14 实验：`--scale worker=3` 全链路 + 心跳面板

> 目标：把前六天攒出来的这套东西真正跑成一个多副本部署——一个镜像起 1 个 Gateway 加 3 个
> Worker 副本，每个副本每 5 秒打一次卡，Gateway 汇总成一张心跳面板，收到 SIGTERM 时先拒新、
> 等手头那次执行跑完、再主动交还租约。做完你能回答生产上最常被问的三个问题：
> 「这个副本是死了还是只是慢」「发版会不会掐断正在跑的对话」「本机调试会不会污染线上」。

## 你会学到

- 用 docker compose 把 worker 扩到 3 个实例
- 实现 worker 心跳上报，gateway 侧记录每个 worker 的最后心跳时间
- 实现 gateway 的健康检查端点，汇总所有 worker 状态
- 实现优雅停机：收到 SIGTERM 后拒绝新任务、等现有任务跑完再退出
- 验证 dev 和 prod 两套配置不会互相影响（如消息总线的 stream 名不同）

## 目录

- `starter/`：挖了 4 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `docker-compose.yml`：**在本 lab 根目录**，一份文件起齐 postgres、redis、gateway 和 3 个 worker 副本

两个变体的 `src/` 结构相同，业务代码只写了一遍：

```text
src/index.ts        入口：自检 / gateway / worker 三种角色，以及自检剧本
src/config.ts       本周固定口径（5 秒心跳 / 15 秒失联 / 20 秒宽限）+ APP_ENV 前缀
src/heartbeat.ts    心跳上报、判活、面板汇总
src/worker.ts       消费循环 + 在途任务登记 + 优雅停机三步
src/gateway.ts      POST /chat 投递、GET /healthz 就绪探针、GET /admin/workers 心跳面板
src/infra/index.ts  Bus / LeaseStore / PresenceStore / RunStore 端口 + 内存实现
src/infra/real.ts   ioredis + pg 的真实实现
```

沿用前几天、本天不改的部分：消费组语义来自 D9，租约的抢占与续约来自 D10，`runs` 表与
`idempotency_key` 唯一约束来自 D8，Dockerfile 的那套规矩来自 D7。**今天新增的只有三样**：
心跳（`heartbeat.ts`）、优雅停机（`worker.ts` 的 `drain`）、环境前缀（`config.ts` 的 `namespaced`），
外加基础设施里那一条新原语 `releaseIfOwner`——主动交还租约，D10 特意留给今天。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace

# 验收入口：一个进程里起 Gateway + 3 个 Worker，按剧本走完五项自检后退出
MOCK=1 SELFTEST=1 pnpm start

# 常驻模式：Gateway 加一个同进程 Worker，方便手动 curl（Ctrl-C 走优雅停机）
MOCK=1 pnpm start
curl -s localhost:3014/healthz
curl -s localhost:3014/admin/workers
curl -s -XPOST localhost:3014/chat -H 'content-type: application/json' \
  -d '{"userId":"u-1","message":"我要退款","workMs":6000}'

# 只跑一个 Worker 副本（compose 里的 worker 服务就是这一支）
MOCK=1 WORKER_ID=w-2 pnpm start:worker
```

`MOCK=1` 下**零外部服务**：不需要 Redis、不需要 Postgres、不需要 Docker、不需要 API key。
`src/infra/index.ts` 里那套内存实现不是打桩——租约的 TTL 到期语义、消费组的 pending 语义、
`idempotency_key` 的唯一约束都真的写了出来，所以离线也能看到今天要教的现象。
自检把时钟等比压缩了 20 倍（心跳 250ms、失联 750ms、宽限 1000ms），比例与生产值一致，
否则你要等一分多钟才能看到一次失联判定。

想看真实版（同一份业务代码，只换 `src/infra/`）：

```bash
docker compose up -d postgres redis    # 在本 lab 根目录，宿主端口 5514 / 6514
cd solution
REDIS_URL=redis://127.0.0.1:6514 \
DATABASE_URL=postgres://koda:koda@127.0.0.1:5514/koda \
SELFTEST=1 pnpm start                  # 第一行会打印「基础设施 real」，五项结果一致
```

多副本部署（本天的正题，需要 Docker）：

```bash
docker compose up -d --build           # postgres + redis + gateway + 3 个 worker 副本
docker compose ps                      # worker-1 / worker-2 / worker-3
curl -s localhost:3014/admin/workers   # 三行心跳，workerId 就是各自的容器主机名
docker compose up -d --scale worker=5  # 副本数改成 5，其他服务不动
# 优雅停机现场：先投一个 6 秒的慢任务，立刻 stop，观察它等任务跑完才退出
curl -s -XPOST localhost:3014/chat -H 'content-type: application/json' \
  -d '{"userId":"u-slow","message":"慢任务","workMs":6000}'
docker compose stop worker             # 大约 5 秒后才停下，日志里能看到「停止取新消息」
docker compose logs worker | tail -5
docker compose down -v                 # 收工
```

想让 compose 跑你自己写的那份，把 `docker-compose.yml` 里两处 `build: ./solution` 改成 `./starter`。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。它可能以非 0 退出并提示
> `Ignored build scripts: esbuild`，那不代表安装失败，看 `pnpm typecheck` 能不能过就行。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 五项自检全部 ✅、退出码 0（`starter/` 原样跑只有第 1 项 ✅，四个练习点各对应一项 ❌）。
2. 第 1 项：3 个副本从同一条流上分摊 9 条消息，每个副本都处理到了，合计 9 条、去重后还是 9 条——没有谁被漏掉，也没有谁被处理两次。
3. 第 2、3 项：让一个副本停止打卡（模拟假死），超过 15 秒（3 个上报周期）后 `/admin/workers` 显示它失联、面板状态降级成 `degraded`，而 `/healthz` 仍然返回 200——执行层少一个副本不该让接入层被摘掉流量。
4. 第 4 项：给一个副本发 SIGTERM，它手头那次执行仍然跑到 `done`（不是停在 `running`），等待时间小于 20 秒宽限；停机信号之后到达的新任务它一条都不碰；`shard 0` 的租约被主动交还（`w-1 → (已交还) → w-4`），接手方在远小于一个租约 TTL 的时间里上岗。
5. 第 5 项：`APP_ENV=dev` 与 `APP_ENV=prod` 算出的流名不同（`dev:koda:runs` / `prod:koda:runs`），往 prod 流投一条消息，dev 侧的探针读到 0 条。

## 常见坑

- **compose 的 `stop_grace_period` 必须大于代码里的宽限。** 代码等 20 秒、compose 默认只等
  10 秒，那么第 10 秒就是 SIGKILL：手头的执行被硬切，租约来不及交还，你写的优雅停机每次都只
  执行到一半。本 lab 给的是 25 秒（Kubernetes 里对应 `terminationGracePeriodSeconds`）。
- **交还租约必须带条件。** 直接 `DEL` 看着更简单，但如果你的租约已经过期、别人刚抢到，
  这一删就把对方的值班牌撕了，两个副本会同时以为自己持有同一个分片。判据和 D10 的续约一样：
  比较持有者和改动必须在同一步里完成（真实实现走一段 Lua，内存实现里那三行之间没有 `await`）。
- **心跳判活的阈值别取一个周期。** 5 秒上报、5 秒判失联的话，一次 GC 停顿就能让面板红一下，
  值班的人看两天就不看它了。3 个周期（15 秒）是能容下两次意外的最小值。
- **`/healthz` 不要把 worker 的心跳算进去。** 看起来越全越好，实际上是给自己装了一个级联下线
  的开关：一个 worker 失联会让所有 Gateway 的就绪探针一起转红，整个接入层被摘光——一个非核心
  故障直接升级成全站故障。面板归面板，探针归探针。
- **`APP_ENV` 前缀只在一个函数里拼。** 散落到各处去拼字符串，漏掉一处就等于没隔离，而且症状
  极其难认：本机发的测试消息被线上的 worker 捞走执行了，两边日志都显示「一切正常」。
