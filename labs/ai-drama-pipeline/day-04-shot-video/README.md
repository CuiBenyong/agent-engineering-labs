# D4 实验：由一条分镜数据生成一个可播放镜头视频的异步任务客户端

> 目标：把「提交拿标识、轮询查状态、取件换地址、下载落盘」这四步亲手写一遍，并让它在排队超时和厂商报错时都做出正确的动作——这一天写的轮询循环，后面十天每一个镜头都在跑它。

## 你会学到

- 实现视频 provider 的提交、轮询、下载三个动作，并各自打印可观察的进度
- 用 D3 的定妆图作首帧，为同一条分镜生成一个镜头视频并落盘
- 把轮询改成指数退避加超时上限，制造一次超时并确认任务被正确取消
- 写出错误分类函数，对四类失败分别给出重试、换参数、报警三种处置
- 在离线模式下用占位视频跑完同一条路径，确认业务逻辑一行都没被绕过

## 目录

- `starter/`：挖了四个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `src/providers/`、`src/ffmpeg.ts`、`src/run.ts`：**来自 D1，本天不改**。首帧那张图仍然走 D1 的 `ImageProvider`
- `src/video-task.ts`：本天的主体。四步接口 `VideoTaskApi`、退避轮询 `pollUntilDone`，外加一个会真的走完状态机的离线任务队列
- `src/failures.ts`：失败分类表与 `withRetry`
- `src/index.ts`：把四步串起来，并依次演示正常路径、超时放弃、分类表

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 MINIMAX_API_KEY；没有 key 先用 MOCK=1
MOCK=1 pnpm start     # 离线占位，零外部依赖
WORK_DIR=~/drama-out pnpm start   # 真实提交视频任务，会真的花钱（产物写仓库外，别被清理脚本删掉）

# 故障注入（全课统一用 INJECT，只在 MOCK=1 下有效）。本天支持四个值：
INJECT=timeout    MOCK=1 pnpm start   # 任务永远排队，验证超时放弃（主流程里已经自动演一次）
INJECT=ratelimit  MOCK=1 pnpm start   # 第一次提交撞 1002，退避后成功
INJECT=blocked    MOCK=1 pnpm start   # 撞 1027 内容审核，程序立刻放弃并说明原因
INJECT=badrequest MOCK=1 pnpm start   # 撞 2013 参数无效
INJECT=taskfail   MOCK=1 pnpm start   # 任务走到 Fail 终态
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。
> 占位视频靠 ffmpeg 生成：macOS 用 `brew install ffmpeg`，Debian 用 `sudo apt-get install -y ffmpeg`。

## 验收标准

1. `MOCK=1 pnpm start` 的第 2 步日志里，四行轮询的「下次 N ms 后」一次比一次大（200 → 300 → 450），最后一行是 `status=Success  ← 终态`，`clip.mp4` 落盘。
2. 第 3 步打印 `✅ 任务超时放弃`，且 `已等待` 的秒数与 2 秒预算对得上——**早退和晚退都判 ❌**，程序会把差值打出来。
3. 第 4 步的分类表里，1002 是 `retry`，1004 与 1008 是 `alert`，1026 / 1027 / 2013 是 `fix-input`；没有整列都是同一种处置。
4. `INJECT=blocked MOCK=1 pnpm start` 直接失败退出，日志说明「要改的是提示词本身，不是重试次数」，且没有出现任何重试行。
5. `pnpm typecheck` 通过，没有 `any`。

## 常见坑

- **把 v1 和 v2 混着写**：同一家还有一套 v2 视频接口，端点、查询参数的形式、状态枚举全都不一样（v2 的状态是小写的，而且没有取件这一步）。照着 v2 的文档去解 v1 的响应，你会拿到一堆 `undefined`。本课统一只用 v1。
- **把 `file_id` 转成数字**：官方两个页面把它分别标成字符串和 int64，做数值转换会在长 id 上丢精度，换来一个查不到的 id。一律按字符串透传。
- **HTTP 200 当成功**：MiniMax 的业务错误码在 `base_resp.status_code` 里，HTTP 层是 200。只判 `res.ok` 会把限流和敏感内容当成正常响应，然后在解析 `task_id` 时收获一个看不懂的 `undefined`。
- **超时判断放在 sleep 之后**：退避到 20 秒间隔时，你会在预算之外多睡一整轮才发现该放弃。判据要写成「睡完会不会越过截止线」。
- **超时就直接重试**：超时的含义是「不知道成没成」，对方队列里那个任务可能还在跑。不带幂等键直接重提，等于为同一个镜头付两次钱——幂等键怎么设计是 D8 的事，这一天先把这句话记进日志。
- **固定间隔轮询**：一个排队五分钟的任务会被你戳三百次，很容易自己把自己限流。间隔要退避，也要有上限。
- **拿到下载地址先存库、回头再下**：视频下载链接是临时的，官方没有写明有效期。正确做法是拿到就落盘，数据库里存本地路径而不是那个 URL。
