# D10 实验：256 shard + 租约 + 双 worker 扩缩容实验

> 目标：把「同一个用户的消息必须按顺序处理」这件事，用 256 个固定分片加一层租约真的做出来——两个 worker 各自持有一批 shard，杀掉其中一个，另一个在租约 TTL 到期后接手它的 shard，而同一个用户的消息序号从头到尾一个都没乱、一个都没重。做完你会亲眼看到租约易主的那一刻，也会看到「假死的前任醒过来继续写」被 fencing token 挡在门外。

## 你会学到

- 实现 userId → shard（256 个）的哈希函数，并验证它稳定且分布均匀
- 用 SET NX + TTL 让 worker 抢占某个 shard 的租约
- 用一段 Lua 脚本做租约续约（比较持有者 + 续期在同一次操作里完成）
- 在一个进程里起两个 worker，观察 256 个 shard 如何在它们之间分配
- 杀掉持有租约的 worker，验证另一个在 TTL 后接手，且同用户消息顺序不乱
- 用 fencing token 拦住脑裂：假死的前任持牌人醒过来后，它的写入必须被拒绝

## 目录

```
src/index.ts        入口：配置口径（TTL 30 秒 / 续约 10 秒）+ 自检与常驻两种模式
src/shard.ts        shardOf：userId → 256 个 shard（练习 1）
src/lease.ts        LeaseManager：抢占、续约、放手、自杀规则（练习 2、3）
src/worker.ts       MessageStore（D8 messages 表的占位，练习 4）+ ShardWorker（练习 5）
src/selftest.ts     单进程双 worker 剧本，逐项打印 ✅/❌
src/infra/index.ts  基础设施端口 + 内存实现（TTL 语义、head-of-line 语义）
src/infra/redis.ts  真实实现：ioredis 5.x + EVAL 跑 Lua
（lab 根目录）docker-compose.yml   redis:7-alpine，真实模式用
```

`src/infra/` 是**端口／适配器**：业务代码（`lease.ts` / `worker.ts`）只认接口，
`MOCK=1` 走内存实现、设置 `REDIS_URL` 走真实 Redis，**两条路跑的是同一份业务代码**。

内存实现**不是打桩**。租约「到点自动失效」的语义、以及「一个 shard 同时只有一个消费者、
前一条没处理完不许跳过去拿后一条」的 head-of-line 语义，正是今天要教的东西——
把它们用 Map 和数组写一遍本身就是教学内容，所以 `MOCK=1` 下看到的现象是真的，不是假装的。
`MemoryLeaseStore.live()` 那几行就是 Redis 的惰性过期（到点不一定立刻删，读到它时才发现它已经没了）。

## 怎么跑

**这个实验是常驻循环，不是跑完就退出的脚本**，所以它有两种跑法。本天**没有模型调用**，
`.env.example` 里的 `OPENROUTER_API_KEY` 用不上，唯一关心的环境变量是 `REDIS_URL`。

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace

# 跑法一（验收命令）：自检模式。一个进程里起两个 worker，按剧本跑完全程，
# 逐项打印 ✅/❌ 再退出，exit code 能直接进 CI。零外部依赖，不需要 Redis、不需要 key。
MOCK=1 SELFTEST=1 pnpm start

# 跑法二：常驻单 worker，供手动复现（Ctrl+C 停）
MOCK=1 pnpm start
```

自检把整个时钟**等比压缩 10 倍**（TTL 3 秒、续约 1 秒），否则跑一遍要两分多钟；
比例关系与生产口径（TTL 30 秒、续约 10 秒）完全一致，代码里的默认值仍然是生产值。

**双终端手动复现租约易主**（这一步必须用真 Redis——内存实现是进程内的，
两个终端各有一份内存，看不到彼此的租约）：

`docker-compose.yml` 在 lab 根目录（`labs/agent-30days/day-10-sharding-lease/`），
`pnpm start:worker` 在 `starter/` 或 `solution/` 里跑，下面标了每条命令在哪执行。

```bash
# 在 lab 根目录：起 Redis
docker compose up -d

# 终端 1（cd starter 或 cd solution）
REDIS_URL=redis://127.0.0.1:6510 WORKER_ID=worker-A pnpm start:worker
# 终端 2（同上）
REDIS_URL=redis://127.0.0.1:6510 WORKER_ID=worker-B pnpm start:worker
# 两边各打印「持有 128 / 256 个 shard」

# 终端 3，在 lab 根目录：看某个 shard 的租约值
# （形如 worker-A|2482，竖线后面是 fencing token）
docker compose exec redis redis-cli get lease:shard:68
docker compose exec redis redis-cli pttl lease:shard:68   # 剩余毫秒数，每 10 秒被续回 30000

# 给某个用户投几条消息：先算它落在哪个 shard，再往对应子流 XADD
node -e "console.log(require('crypto').createHash('sha1').update('u-1001').digest().readUInt32BE(0)%256)"
docker compose exec redis redis-cli XADD koda:runs:s<上一步算出的数字> '*' userId u-1001 seq 1 text 你好

# 然后 Ctrl+C 掉持有该 shard 的那个终端，盯住另一个终端：30 秒内它会把这批 shard 接过去
```

`pnpm start:worker` 读 `WORKER_ID` 环境变量，和 `pnpm start` 是同一个入口，
只是名字更直白，D14 的 compose 也会用它起多个副本。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` **五项自检全是 ✅**，退出码 0。`starter/` 原样跑是
   **五项全 ❌**（练习 2 没做会连带影响 3、4，这是故意的：租约不生效之后所有顺序保证一起崩）。
2. 第 1 项显示「2000 个用户占 **256/256** 个 shard，最大桶 19 条左右（理想 8）」——
   `starter/` 里那个按长度分片的版本会显示「占 **1/256** 个 shard，最大桶 2000 条」。
3. 第 2 项显示「A 持有 128 个、B 持有 128 个，**交集 0 个、并集 256 个**」。
   交集不为 0 就说明 SET 少了 NX，两个 worker 同时以为自己持有同一个 shard。
4. 第 4 项显示 `u-1000` 的处理顺序是 **[1, 2, 3, 4, 5, 6]**、后三条由接手的那个 worker 处理，
   上一行 trace 打出「shard 68 在失联 2.8 秒左右后被 worker-B 接手」。
   `starter/` 会打出类似 `[1, 3, 2, 5, 6, 4]` 的乱序。
5. 第 5 项显示假死的前任「拿旧号续约**被拒**、写入**被拒**」（任何一半是「成功（危险）」
   都算没通过）；`pnpm typecheck` 干净；真实模式
   `REDIS_URL=redis://127.0.0.1:6510 SELFTEST=1 pnpm start` 的五项结果与 `MOCK=1` 一致。

## 常见坑

- **续约写成「先 GET 再 PEXPIRE」**：两步之间的那一瞬间（哪怕只有 2 毫秒）租约可能刚好到期
  并被另一个 worker 抢走，你的 `PEXPIRE` 于是替**对手**把任期延长了 30 秒，而你自己还以为
  自己持有。这就是 `starter/` 练习 3 的默认实现，自检第 5 项会当场抓住它。
  正确做法是一段 Lua：`GET` 比较持有者和 `PEXPIRE` 续期必须在同一次 `EVAL` 里完成。
- **续约返回 0 只打条日志就继续跑**：`renewIfOwner` 返回 0 不是「重试一下」，是「立刻放手」——
  从持有集合里删掉这个 shard、停止消费它、手上那条没做完的消息不许再写。
  少了这一步，你的进程会在完全不知情的情况下和继任者同时处理同一个用户。
- **用 `Promise.all` 并发处理同一批消息**：吞吐确实上去了，同一个用户的顺序当场丢掉。
  租约保住的是**跨进程**的顺序，`await` 保住的是**进程内**的顺序，缺一不可。
  正确的并行单位是 **shard**，不是消息：每个持有的 shard 各起一条独立处理链，互不阻塞。
  同理，接管时要**先把前任在途那条 claim 回来再读新消息**（D9 的 `XAUTOCLAIM`），
  否则新消息会插到那条已领未 ack 的旧消息前面。
- **以为 `SET NX` 就等于绝对互斥**：TTL 到期不等于前任真的死了——它可能只是 GC 卡了 5 秒，
  醒过来时内存里还写着「我持有」。所以有副作用的写入必须带 fencing token 做条件更新
  （`MessageStore.write` 里那一行），把「谁的写入能落地」这件事交给下游裁决。
- **两个终端 + `MOCK=1` 看不到租约易主**：内存实现是进程内的，两个终端各有一份内存。
  手动复现必须 `docker compose up -d` 起 Redis 并设置 `REDIS_URL`。
