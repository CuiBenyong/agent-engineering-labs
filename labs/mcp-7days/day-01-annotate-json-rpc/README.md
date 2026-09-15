# D1 实验：一份逐字段标注过的 MCP 会话报文记录

> 目标：亲眼看一遍 MCP 服务端与客户端之间真正传的字节，并把每个字段的来历（JSON-RPC 规定的还是 MCP 加的）标清楚。做完这一份，后面六天的调试都会快一倍——因为你不用再猜线上发生了什么。

## 你会学到

- 在本机用 Node 起一个现成的 MCP 服务端，观察它的 stdin 与 stdout
- 把一轮完整会话的报文抄进记录表：server/discover、tools/list、tools/call
- 对每条报文逐字段标注：哪些是 JSON-RPC 规定的，哪些是 MCP 加的
- 标出协议版本、客户端能力、resultType 三处，并说明少了会怎样
- 写下你观察到的一处与旧版本文档不一致的地方

## 目录

- `demo-server.mjs`：按 2026-07-28 规范手写的演示服务端，零依赖、不联网
- `demo-client.mjs`：把服务端拉起来跑一轮会话，并把双向报文原样打印出来
- `starter/transcript-annotations.md`：留了空位的记录表，你要填的就是它
- `solution/transcript-annotations.md`：填好的参考答案

这是一个**文档型实验**，产出是一份 Markdown 记录，不需要安装任何依赖。

## 怎么跑

```bash
# 需要 Node 22（用 node --version 确认）。没有 npm install 这一步，两个脚本都零依赖。
node demo-client.mjs

# 想慢慢标注就把报文存下来
node demo-client.mjs > transcript.txt
```

你会在屏幕上看到五轮往返，每一轮都同时打印客户端发出去的和服务端回来的原始 JSON：

```text
=== 第 1 轮：server/discover（这一版新增，服务端必须实现）===

--> 客户端 -> 服务端
{ ... }

<-- 服务端 -> 客户端
{ ... }
```

然后打开 `starter/transcript-annotations.md`，照着表格把字段填满。填完再对 `solution/`。

## 验收标准

1. 记录表里有 `server/discover`、`tools/list`、`tools/call` 三轮完整的请求与响应报文
2. 每条报文的每个顶层字段都有一句标注，说明它是 JSON-RPC 规定的还是 MCP 加的
3. 明确指出了协议版本、客户端能力、`resultType` 三处所在的位置，以及各自缺失时的后果
4. 写下了至少一处「网上教程与 2026-07-28 规范不一致」的观察，并注明依据哪一页

## 常见坑

- **把 `isError: true` 当成失败的 JSON-RPC 响应。** 它是一个成功的响应，`resultType` 仍然是 `complete`，只是业务上没成。判据是「模型换个参数有没有可能成功」：有就用 `isError`，没有就回 JSON-RPC 的 `error`。
- **以为 `clientCapabilities` 可以省略。** 协议是无状态的，服务端不能靠上一条请求记住你的能力，所以哪怕是空对象也必须每条都带。第 5 轮就是故意漏掉版本字段让你看服务端怎么拒绝。
- **拿网上的旧教程对答案。** 搜到的中文材料大多停在 `2025-11-25`：还在讲 `initialize` 握手、`Mcp-Session-Id` 会话头、GET 长连接。这三样在 2026-07-28 里全被删了。判断材料新不新，搜它有没有提 `server/discover` 和 `resultType`。
- **在服务端往 stdout 里 `console.log` 调试信息。** stdio 传输规定 stdout 里不能出现任何非 MCP 消息，多打一行客户端就解析失败。日志一律走 stderr——`demo-server.mjs` 里那行 `process.stderr.write` 就是这个原因。

## 许可

代码 MIT。
