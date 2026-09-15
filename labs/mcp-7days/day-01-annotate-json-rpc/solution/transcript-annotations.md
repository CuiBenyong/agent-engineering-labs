# MCP 会话报文标注记录（solution）

> 报文来自 `node ../demo-client.mjs` 的真实输出（2026-07-28 规范）。
> 标注记号：`[RPC]` 是 JSON-RPC 2.0 本身规定的字段，`[MCP]` 是 MCP 额外加的。

## 第 1 轮：server/discover

### 请求

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "d1-demo-client", "version": "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

| 字段           | 记号    | 它是干什么的                                                                   |
| -------------- | ------- | ------------------------------------------------------------------------------ |
| `jsonrpc`      | `[RPC]` | 固定 `"2.0"`，声明这条消息用的是 JSON-RPC 2.0                                  |
| `id`           | `[RPC]` | 请求标识，响应用同一个值回来；MCP 额外要求它不能是 `null`                      |
| `method`       | `[RPC]` | 方法名。`server/discover` 是 MCP 定义的方法，但「有 method 字段」是 RPC 规定的 |
| `params._meta` | `[MCP]` | MCP 把自己的协议元数据全塞在这里，对 JSON-RPC 来说它只是普通参数               |

### 响应

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": { "tools": {} },
    "instructions": "一个只有天气查询的演示服务端。",
    "ttlMs": 3600000,
    "cacheScope": "public",
    "_meta": {
      "io.modelcontextprotocol/serverInfo": { "name": "demo-weather-server", "version": "0.1.0" }
    }
  }
}
```

| 字段                          | 记号    | 它是干什么的                                                               |
| ----------------------------- | ------- | -------------------------------------------------------------------------- |
| `result.resultType`           | `[MCP]` | 这一版新增的必填字段，`complete` 表示已完成，`input_required` 表示还缺输入 |
| `result.supportedVersions`    | `[MCP]` | 服务端支持的协议版本列表，客户端从里面挑一个用于后续请求                   |
| `result.capabilities`         | `[MCP]` | 服务端提供哪些原语。这里只有 `tools`，说明它没有资源也没有提示模板         |
| `result.ttlMs` / `cacheScope` | `[MCP]` | 缓存提示：可缓存 1 小时，`public` 表示中间层也可以缓存                     |
| `result._meta.serverInfo`     | `[MCP]` | 服务端自报家门。**未经验证，只能用于显示和日志，不能用于安全判断**         |

## 第 2 轮：tools/list

### 请求

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "d1-demo-client", "version": "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

注意即使这一轮完全不需要客户端能力，`clientCapabilities` 仍然是必填的——因为协议无状态，服务端不能靠上一条请求记住它。

### 响应

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "resultType": "complete",
    "tools": [
      {
        "name": "get_weather",
        "title": "天气查询",
        "description": "查询某个城市当前的天气。city 传中文或英文城市名均可，例如「上海」或「Seattle」。",
        "inputSchema": {
          "type": "object",
          "properties": { "city": { "type": "string", "description": "城市名" } },
          "required": ["city"]
        },
        "outputSchema": {
          "type": "object",
          "properties": { "celsius": { "type": "number" }, "conditions": { "type": "string" } },
          "required": ["celsius", "conditions"]
        },
        "annotations": { "readOnlyHint": true, "idempotentHint": true, "openWorldHint": true }
      }
    ],
    "ttlMs": 300000,
    "cacheScope": "public"
  }
}
```

一句话说明：一个 Tool 对象里，哪几个字段是给模型看的、哪几个是给人看的？

> 给模型看的是 `name`、`description`、`inputSchema` 里的每一条 `description`——模型就是靠这几行决定要不要调、怎么填参数。给人看的是 `title` 和 `icons`，客户端拿它们渲染界面。`outputSchema` 两边都用得上：客户端拿它校验结构化返回，模型拿它预判会拿到什么。`annotations` 是给客户端做界面与确认策略的提示，**规范明确要求把它当成不可信输入**。

## 第 3 轮：tools/call

### 请求

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "city": "上海" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "d1-demo-client", "version": "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

### 响应（正常）

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "resultType": "complete",
    "content": [{ "type": "text", "text": "{\"celsius\":24,\"conditions\":\"多云\"}" }],
    "structuredContent": { "celsius": 24, "conditions": "多云" },
    "isError": false,
    "_meta": {
      "io.modelcontextprotocol/serverInfo": { "name": "demo-weather-server", "version": "0.1.0" }
    }
  }
}
```

`content` 是非结构化内容，喂给模型；`structuredContent` 是结构化内容，喂给代码。规范建议**两个都给**，因为老客户端只认 `content`。

### 响应（工具执行错误）

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "resultType": "complete",
    "content": [{ "type": "text", "text": "没有 火星 的数据。可用城市：上海、Seattle。" }],
    "isError": true,
    "_meta": {
      "io.modelcontextprotocol/serverInfo": { "name": "demo-weather-server", "version": "0.1.0" }
    }
  }
}
```

`isError: true` 和 JSON-RPC 的 `error` 有什么区别？各自应该在什么时候用？

> `isError: true` 是「工具跑了，但业务上没成」，它仍然是一个成功的 JSON-RPC 响应，`resultType` 照样是 `complete`。客户端**应该**把它喂回模型，让模型自己改参数重试——所以文案要写成对模型有用的样子，像上面那样把可选值列出来。JSON-RPC 的 `error` 是「这个请求本身不对」：工具名不存在、参数结构不合法、服务端内部炸了。模型改参数也救不回来，客户端**可以**给模型看，但通常帮不上忙。一句话判据：**模型换个参数有没有可能成功？有就用 `isError`，没有就用 `error`。**

## 三处关键位置

| 要找的东西   | 它在报文的哪个路径下                                                | 缺了会怎样                                                                                                           |
| ------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 协议版本     | 请求的 `params._meta["io.modelcontextprotocol/protocolVersion"]`    | 请求算畸形，服务端必须回 `-32602`（HTTP 上还要回 400）；版本不受支持则回 `-32022` 并附上支持列表                     |
| 客户端能力   | 请求的 `params._meta["io.modelcontextprotocol/clientCapabilities"]` | 同样算畸形回 `-32602`。若服务端需要一个客户端没声明的能力，回 `-32021` 并在 `data.requiredCapabilities` 里列出缺哪些 |
| `resultType` | 响应的 `result.resultType`                                          | 这一版的必填字段。老服务端不带它，客户端**必须**当成 `complete` 处理                                                 |

## 我发现的一处「教程与 2026-07-28 规范不一致」

- 我看到的说法：绝大多数中文教程和视频都说「连上 MCP 服务端第一步是 initialize 握手，然后发 notifications/initialized」，还有不少讲 `Mcp-Session-Id` 会话头。
- 规范怎么说：`2026-07-28` 的 Key Changes 第 1、2 条明确写着删除协议级会话与 `Mcp-Session-Id`、删除 `initialize` 与 `notifications/initialized` 握手，改为每条请求在 `_meta` 里携带版本与能力；同一页第 3 条新增 `server/discover`。传输页（Streamable HTTP）也写明 GET 端点与 `Last-Event-ID` 续传一并移除。
- 为什么会有这个差异：那些教程写于 `2025-11-25` 及更早的版本。**官方 JavaScript SDK 到 1.30.0 为止实现的仍然是 `2025-11-25`**，所以照着 SDK 抄出来的文章自然还是旧握手；Python 侧的 `mcp` 2.1.1 已经跟上了 `2026-07-28`。判断一份材料新不新，最快的办法是搜它有没有提 `server/discover` 和 `resultType`。
