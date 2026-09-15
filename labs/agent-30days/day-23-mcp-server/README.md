# D23 实验：写一个 MCP server 接入 agent

> 目标：把两个电商客服工具从「写死在 Agent 里的函数」搬成一个独立的 MCP server 进程，
> 再用一个 MCP client 把它们发现回来、翻译成 function calling 的 JSON Schema 发给模型，
> 跑通「起 server → 连上 → `tools/list` → Agent 通过 `tools/call` 调到工具」这条完整链路。
> 做完你就能亲手证明那句最值钱的话：**MCP 不是 function calling 的升级版，它是它的上游**——
> server 列出的每个 tool，最后仍然要被翻译成 function calling 的形状发给模型。

## 你会学到

- 用 `McpServer` 暴露工具，并明白 stdio 传输下为什么一行 `console.log` 就能把协议打断
- 用 `Client` + `StdioClientTransport` 把 server 当子进程拉起来，走完 initialize 握手
- 写出那个只有几行、却是全天立论点的映射函数：MCP 的 `inputSchema` → function calling 的 `parameters`
- 分清 MCP 的两类失败——业务失败走结果里的 `isError`，协议失败走 JSON-RPC error——并把两者合并成同一种给模型看的纠错说明
- 写出一条可执行的选型判据，让「不上 MCP」成为默认答案

## 目录

- `starter/`：挖了 5 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案

两个变体的 `src/` 结构相同，业务代码只写了一遍：

```text
src/tools.ts        领域工具：query_order / track_shipment 的 schema 与实现，完全不知道 MCP 的存在
src/mcp-server.ts   MCP server 进程入口：registerTool + stdio 传输（另有 Streamable HTTP 模式）
src/mcp-client.ts   连接 server、initialize、tools/list、tools/call 的封装
src/bridge.ts       MCP tool → function calling schema 的映射、结果压平、选型判据
src/model.ts        唯一的网络出口，MOCK=1 在这里打桩
src/agent.ts        Agent 循环（D2 那个循环，一行没变，只是工具来自 MCP）
src/index.ts        入口：自检 / 单次问答两种模式
```

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace

# 验收入口：起 server、握手、列工具、翻译 schema、跑两轮对话，逐项打印 ✅/❌ 后退出
MOCK=1 SELFTEST=1 pnpm start

# 单次问答：自己换一句问题看它选哪个工具
MOCK=1 pnpm start "帮我查一下订单 SO20260902 现在什么状态"
```

`MOCK=1` 只挡住模型调用这一个网络出口，**MCP server 照样真的被 spawn 起来、真的走协议**：
所以自检里看到的 `tools/list` 结果、参数校验报错、`tools/call` 的返回，全部是真实往返出来的，
不是假数据。没有 API key、没有 Docker、没有任何外部服务也能跑。

去掉 `MOCK=1` 并在 `.env` 里填 `OPENROUTER_API_KEY`，选工具和填参数就交给真模型，
`src/` 其余部分一行都不用改——这正是「翻译成 function calling」这一步值钱的地方。

想看远程传输（Streamable HTTP，本课固定用 3023 端口）：

```bash
cd solution
MCP_TRANSPORT=http pnpm start:server          # 另开一个终端

curl -s -X POST http://127.0.0.1:3023/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

同一个 `createMcpServer()`，换个 transport 就从本地子进程变成了远程服务，工具定义一行不改。
旧的 HTTP+SSE 传输在官方 SDK 里已经标成 legacy，只为向后兼容保留，新写的不要用。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 六项自检全部 ✅，退出码为 0（`starter/` 原样跑只有第 1 项 ✅，退出码 1）。
2. 第 2 项证明 server 侧真的把两个工具暴露出去了：`tools/list` 返回 `query_order` 与 `track_shipment`，
   且 `order_id` 的 JSON Schema 里带着 `^SO\d{8}$` 这条格式约束——**宿主一行代码没改**。
3. 第 3 项证明翻译是原样搬运：`toFunctionTool` 出来的 `parameters` 与 MCP 的 `inputSchema` 逐字段相等，
   `required` 里有 `order_id`。这一步做不对，模型会看到一个「不接受任何参数」的工具。
4. 第 4 项证明链路打通：一句「帮我查一下订单 SO20260901 现在什么状态」走完
   模型选工具 → MCP `tools/call` → 结果回填 → 模型收尾，最终回答里出现「已发货」。
5. 第 5 项证明错误回传：查一个格式合法但不存在的订单号，第一次调用失败且报错原文
   （含「本店近期的订单号形如 SO20260901」）被回填给模型，模型第二次换对参数并答出结果，共调用 2 次。
6. 第 6 项证明选型判据：三条判据一条都不命中时 `shouldUseMcp` 返回「直接写 function calling」。
7. `pnpm typecheck` 通过，没有 `any`。

## 常见坑

- **stdio server 里写了 `console.log`。** stdout 是 JSON-RPC 的专用管道，多打一行普通文本，
  client 侧就会收到一条解析不了的消息，表现是 initialize 卡住或者直接报解析错误。
  这个坑最阴的地方在于：你本地单独跑 `pnpm start:server` 一切正常，只有被当子进程接进去才炸。
  **stdio server 的所有日志一律走 `console.error`。**
- **把 MCP 的 `isError` 当成异常。** 它是协议里的一个字段：这次 RPC 成功了，只是工具在业务上失败了。
  真正会抛异常的是另一类——参数没过 schema 校验、工具名不存在，那走的是 JSON-RPC error。
  两类都要接住并变成给模型看的纠错说明；只 `try/catch` 一类，另一类就会以「模型收到一句空话」的形式静默跑偏。
- **翻译那一步偷懒，只搬了名字。** `description` 和 `inputSchema` 是模型选工具、填参数的**全部**依据，
  漏了任何一个，模型都只能靠工具名猜。现象是它交上来一个空参数对象，然后被 server 挡回来。
- **假设 `tools/list` 只调一次。** server 可以在运行中增删工具并发 `listChanged` 通知，
  长驻宿主要么订阅这个通知、要么定期重新拉一次。本实验是一次性脚本，所以只拉了一次。
- **拿 MCP 当默认答案。** 只给自己一个 Agent 用、自己维护、也不需要热插拔的能力，包成 MCP server
  只是多一个进程、多一次握手、多一层排障。三条判据一条都不命中就直接写 function calling。
