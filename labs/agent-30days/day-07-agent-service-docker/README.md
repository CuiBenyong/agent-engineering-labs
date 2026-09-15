# D7 实验：`agent-service` 可容器化运行

> 目标：把前六天那个只有你自己在命令行用的 Agent，变成一个别人能调用的 HTTP 服务——用 Fastify 暴露 `POST /chat`，用 SSE 把回复一个字一个字推出去，再用一个 Dockerfile 把它装进镜像。做完这一步，你的 Agent 才第一次具备「交给别人用」的形态，W2 拆 Gateway/Worker 也才有东西可拆。

## 你会学到

- 用 Fastify 写一个 POST /chat 接口，内部调用 Agent
- 把 Agent 的流式输出通过 SSE 推给客户端
- 写一个最小 Dockerfile，本地 docker build 并 docker run 起服务
- 用 curl 或简单页面验证 SSE 能正常接收流式片段
- 写一段 W1 复盘笔记，梳理本周学到的核心概念

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- 两边各有一份 `Dockerfile` 与 `.dockerignore`，内容相同（Docker 那一步不挖空，重点是读懂每一行为什么这么写）

**实验边界（先看这一段，免得以为 W1 白做了）**：这个实验聚焦**服务层**——SSE 响应头与分帧、
心跳、客户端断开、容器化，也就是正文点名的四个坑。至于 Agent 内核，这里用一个**最小替身**
代替：`streamChat` 只做「把回复一个字一个字吐出来」，没有工具、没有会话回填。
前六天做的那个完整 Agent（D3 的循环 + D4 的模型调用层 + D5 的工具与事件 + D6 的会话）
**接进来只是把 `streamChat` 这一个函数换掉**，`/chat` 的接口形状、SSE 帧格式、断开处理一行都不用改。
之所以这么切，是因为服务层的四个坑各自都能独立翻车，混进 Agent 逻辑只会让你分不清是哪一层出的问题。

会话历史这里放在进程内存的 `Map` 里，**不是**沿用 D6 的 `.sessions/*.jsonl`：多实例部署时
每个进程各写各的本地盘，用户第二次请求被负载均衡打到另一台就读不到自己的历史。
这是服务化引入的新问题，D8 会用 Postgres 正面解决。

## 怎么跑

**这个实验是一个常驻的 HTTP 服务，不是跑完就退出的脚本。** 所以它有两种跑法：

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 先用 MOCK=1

# 跑法一（推荐当验收命令）：自检模式。启动后自己给自己发几个请求，
# 把结果打印出来再退出，exit code 是 0，能直接进 CI。
MOCK=1 SELFTEST=1 pnpm start

# 跑法二：常驻服务，另开一个终端用 curl 验证（Ctrl+C 停）
MOCK=1 pnpm start
curl -N -X POST http://127.0.0.1:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好","sessionId":"demo"}'
```

`curl` 的 `-N` 是关掉 curl 自己的输出缓冲，不加的话你会等一整段才看到全部内容，
把服务端的流式误判成「没生效」——**验证流式接口时忘了 `-N` 是最常见的假故障。**

容器里跑：

```bash
docker build -t agent-service .
docker run --rm -e MOCK=1 -e SELFTEST=1 agent-service     # 容器内自检
docker run --rm -p 3000:3000 -e MOCK=1 agent-service      # 常驻，宿主机 curl 同上
```

真模型不要把 key 打进镜像，运行时传进去：`docker run --rm -p 3000:3000 --env-file .env agent-service`。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

`MOCK=1` 下不需要任何 key：唯一的网络出口 `streamChat` 会在最前面返回一段假回复，
每个字之间隔 30 毫秒，节奏和真模型一样——所以 SSE 分帧、心跳、断开处理这些逻辑在离线状态下
全都真实执行，实验不会因为没有 key 而白做。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 四项自检**全是 ✅**。`starter/` 原样跑的样子是
   **第 1、2 项 ✅、第 3、4 项 ❌**（外加第 4 项下面的「心跳定时器」那一行也是 ❌）——
   前两项是脚手架已经写好的健康检查和参数校验，四个挖空点影响的是后两项。先跑一次记住它。
2. 第 3 项显示 `Content-Type: text/event-stream; charset=utf-8`，并且**收到 103 个 delta 事件、1 个 done 事件**，
   拼回来的回复是完整一句话——不是「收到 0 个事件」。
3. 第 4 项显示「客户端读到 5 个片段就断开：服务端一共生成了 6 个片段 ✅」——
   数字远小于 103，证明用户关掉页面之后服务端**真的停止生成了**，没有继续烧 token。
4. 另开终端 `curl -N -X POST .../chat` 能看到一帧一帧的 `event: delta` 逐条冒出来，
   而不是等几秒钟一次性刷屏；`pnpm typecheck` 通过，没有 `any`。
5. （可选，机器上有 Docker 才做）`docker build -t agent-service .` 成功，
   `docker run --rm -e MOCK=1 -e SELFTEST=1 agent-service` 的四项自检和本机一致；
   `docker run -p 3000:3000` 后宿主机 curl 得通；`docker stop` **一秒内**返回（而不是卡满 10 秒），
   说明 SIGTERM 传到了 node 进程、优雅退出生效了。

## 常见坑

- **监听 `request.raw` 的 'close' 当断线信号**：Node 里 request 的 `'close'` 在**请求体读完时**就会触发，
  不是连接断开时。拿它当断线信号，每一条正常请求都会被误判成「客户端跑了」，你会看到每次只推出一两个
  片段就停。要监听的是**响应对象** `reply.raw` 的 `'close'`，再用 `writableEnded` 区分「正常收尾」和「被掐断」。
- **忘了 `reply.hijack()`**：直接往 `reply.raw` 写字节，同时 Fastify 又想帮你序列化一个返回值，
  两边抢同一个响应，轻则报 header 已发送，重则连接被提前关掉。
- **SSE 一帧少写一个换行**：`data: {...}\n` 只有一个换行，客户端会一直等下去，看起来像服务端卡住。
  **空行才代表一帧结束**，必须是 `\n\n`。
- **响应头写成 `application/json`**：`curl` 看着没事，浏览器的 `EventSource` 会直接判定连接失败且不重连。
  另外少了 `X-Accel-Buffering: no`，本机好好的，一挂到 Nginx 后面流式就变成一次性返回。
- **容器里监听 127.0.0.1**：本机 `pnpm start` 完全正常，一进容器就连不上，
  因为 `-p` 映射的是容器的 0.0.0.0。Dockerfile 里的 `ENV HOST=0.0.0.0` 就是为这件事。
- **`CMD ["pnpm", "start"]`**：PID 1 变成包管理器，`docker stop` 的 SIGTERM 未必传得到 node，
  优雅退出的代码永远不执行，只能等 10 秒超时后被 SIGKILL——对 SSE 长连接就是所有在途的流被硬切。
- **把 `.env` 打进镜像**：`.dockerignore` 里必须排除它，否则谁能 `docker pull` 谁就拿到了你的 key。
