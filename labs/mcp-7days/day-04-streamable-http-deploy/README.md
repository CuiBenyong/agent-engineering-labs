# D4 实验：一个可容器化部署的 Streamable HTTP MCP 服务端

> 目标：手写一个符合 2026-07-28 规范的远程 MCP 端点——只有一个 POST 路径、两种响应形态、一套必填请求头，并且因为协议无状态，起两个副本就能被同一个客户端轮着打。做完这一份，你就知道公网上那些 MCP 服务端的报文长什么样、以及哪几条校验漏了会变成漏洞。

## 你会学到

- 读 solution 的 HTTP 入口，找到来源校验、请求头校验与两种响应分支
- 在 starter 里补全请求头与请求体的一致性校验并返回规定错误码
- 补全事件流分支，让一个慢工具边算边发进度通知
- 补全需要客户端补充输入时的返回，并让客户端带着输入重试一次
- 用实验根目录的 compose 文件起两个副本，确认同一个客户端轮流打到两边都能跑通

## 为什么不用官方 SDK

这一天是全课唯一一次刻意绕开 `@modelcontextprotocol/sdk`。实测（2026-09-06）：npm 上最新的 JavaScript SDK 是 **1.30.0**，它的 `LATEST_PROTOCOL_VERSION` 仍然是 `2025-11-25`，代码里既没有 `resultType` 也没有 `server/discover`，Streamable HTTP 那一层还会铸 `Mcp-Session-Id`、还挂着 GET 长连接。照它写，你学到的是**上一版**的传输绑定，恰好是这一天要讲的东西全被改掉的那一版。

Python 侧的 `mcp` 2.1.1 已经跟上了（`LATEST_PROTOCOL_VERSION` 就是 `2026-07-28`，`InputRequiredResult` / `DiscoverRequest` / `SubscriptionsListenRequest` 都在），但本课的 lab 统一是 TypeScript 工程。

所以这里手写：整个端点连注释也就两百来行，规范的每一条 MUST 都能一眼对上，反而比读 SDK 源码快。**这不代表生产里也要手写**——等 SDK 跟上以后照样用 SDK，你只是需要知道它替你做了什么。

## 目录

- `starter/`：挖了 4 个练习点的起始代码，直接跑得起来，只是有 5 项自测是红的
- `solution/`：参考答案，8 项自测全绿
- `Dockerfile` 与 `docker-compose.yml`：放在**实验根目录**，用来起两个副本
- `starter/src/` 与 `solution/src/` 各四个文件：
  - `protocol.ts`：协议常量、错误码、请求头值编解码、`requestState` 的签发与验签
  - `tools.ts`：三个工具，分别演示单个 JSON、事件流、需要补充输入
  - `server.ts`：HTTP 端点本体（来源校验、请求头校验、两种响应分支）
  - `selftest.ts`：`SELFTEST=1` 的验收编排，不是教学重点

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
MOCK=1 SELFTEST=1 pnpm start   # 起服务、自己给自己发请求、逐项打印 ✅/❌ 后退出
MOCK=1 pnpm start              # 常驻在 127.0.0.1:3034，供你手动 curl
```

> `pnpm install --ignore-workspace` 可能以非 0 退出（pnpm 拦截了依赖的构建脚本），这不代表安装失败。看 `node_modules` 有没有生成、以及后面的 `pnpm typecheck` 和 `pnpm start` 正不正常。

`starter` 跑出来应该是 **3 项 ✅ / 5 项 ❌**，`solution` 是 **8 项全 ✅**。你的任务就是把那 5 个 ❌ 变绿。

手动 curl 一条（**必填头一个都不能少**）：

```bash
curl -i -X POST http://127.0.0.1:3034/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/call' \
  -H 'mcp-name: echo_upper' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{
      "name":"echo_upper","arguments":{"text":"hello mcp"},
      "_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}
      }
    }
  }'
```

把 `mcp-method` 改成别的值再发一次，你会拿到 `400` 和 `-32020`。

看事件流那条（注意 `content-type` 变成了 `text/event-stream`）：

```bash
curl -N -X POST http://127.0.0.1:3034/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/call' \
  -H 'mcp-name: analyze_corpus' \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{
      "name":"analyze_corpus","arguments":{"documents":["a b c","d e","f g h i"]},
      "_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{},
        "progressToken":"p-1"
      }
    }
  }'
```

## 起两个副本

```bash
docker compose up -d --build
curl -s http://127.0.0.1:3034/healthz   # 副本 A
curl -s http://127.0.0.1:4034/healthz   # 副本 B
docker compose down
```

然后把上面那条 `tools/call` 的 curl 轮流打到 3034 和 4034，两边返回一模一样——**这就是无状态换来的东西**：没有会话要保持，负载均衡不用配粘性路由，任何一个副本都能处理任何一条请求。

更狠的一个演示：**在副本 A 上发起多轮请求，到副本 B 上完成它**。

```bash
# 第一轮打 3034，服务端回 input_required 并签发一个 requestState
STATE=$(curl -s -X POST http://127.0.0.1:3034/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: book_meeting' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"book_meeting","arguments":{"topic":"kickoff"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{}}}}}}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['requestState'])")

# 第二轮换一个 JSON-RPC id、换一个副本（4034），带着原样的 state 和补齐的输入
curl -s -X POST http://127.0.0.1:4034/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: book_meeting' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"book_meeting\",\"arguments\":{\"topic\":\"kickoff\"},\"inputResponses\":{\"attendee_email\":{\"action\":\"accept\",\"content\":{\"email\":\"a@example.com\"}}},\"requestState\":\"$STATE\",\"_meta\":{\"io.modelcontextprotocol/protocolVersion\":\"2026-07-28\",\"io.modelcontextprotocol/clientCapabilities\":{\"elicitation\":{\"form\":{}}}}}}"
```

会议真的被创建出来了，尽管两轮请求分别落在两个互不通信、没有共享存储的进程上。**上一版做不到这件事**——那时候服务端主动发 `elicitation/create` 请求，等于把这次交互钉死在一条连接上。

唯一需要两边共享的是 `REQUEST_STATE_SECRET`（compose 里已经设成同一个值），否则副本 A 签发的 `requestState` 拿到副本 B 会验不过。注意这不是「会话」——它是一段签过名的、由客户端携带的自包含状态，服务端内存里为这个客户端留的东西仍然是零。

没装 Docker 也不影响做完这个实验，开两个终端分别用 `PORT=3034` 和 `PORT=4034` 起两个进程，效果一样。

## 验收标准

1. `starter` 里的 4 个练习点全部补完，`MOCK=1 SELFTEST=1 pnpm start` 的 8 项自测全绿且退出码为 0
2. 慢工具那一项能看到 `content-type` 是 `text/event-stream`，且最终响应之前至少收到 2 条 `notifications/progress`
3. 缺 `MCP-Protocol-Version` 头、以及 `Mcp-Method` 头与请求体不一致时，都回 `400` 与 `-32020`
4. 预约会议的工具第一轮返回 `resultType` 为 `input_required`，客户端带上 `inputResponses` 和原样的 `requestState`、换一个 JSON-RPC id 重试后拿到最终结果
5. 用 compose 起两个副本后，同一条 `tools/call` 打到 3034 和 4034 都能拿到相同结果

## 常见坑

- **`Mcp-Name` 只解码一半就去比对。** 工具名或资源 URI 一旦不是纯 ASCII（比如中文工具名），客户端必须用 `=?base64?...?=` 哨兵格式编码；服务端**必须先解码再比对**，否则一个正常请求会被自己的校验判成头体不一致。`decodeHeaderValue` 就是干这个的。
- **在事件流里发独立的 JSON-RPC 请求。** 这是上一版的做法，这一版明确禁止：服务端要客户端配合时只能返回 `InputRequiredResult`。流上只允许发与本请求相关的通知，最后由响应终止这条流。
- **客户端没给 `progressToken` 也照发进度。** 规范规定进度通知只能引用客户端在本次请求里提供的 token。代码里那个 `progressToken === undefined ? undefined : ...` 不是防御性编程，是硬要求。
- **把 `requestState` 当成自己的私有存储。** 它经客户端的手转了一圈，是攻击者可控输入。必须验签（用定长比较），并把认证主体、原请求标识、短过期一起签进去，否则就是把跨用户重放的口子留在那儿。自测第 8 项专门验这个。
- **忘了 `X-Accel-Buffering: no`。** 本机跑一切正常，一上 nginx 反代进度就全攒到最后一起到，看着像服务端没发。

## 许可

代码 MIT。
