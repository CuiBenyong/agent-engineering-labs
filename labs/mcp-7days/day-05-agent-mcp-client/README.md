# D5 实验：一个能聚合多个 MCP 服务端的手写客户端与 Agent 循环

> 目标：站到桌子的另一边，手写一个 MCP 客户端——拉起两个现成服务端、翻完分页把工具全拿到手、翻译成模型 API 认识的形状、处理两个 `search` 撞名、再让其中一个服务端超时，看整轮对话能不能活下来。做完这一份，你就知道 Claude Desktop 之类的宿主在你按下回车之后到底替你做了哪些事。

## 你会学到

- 读 solution 里的最小客户端，找到发现、调用、关闭三个阶段
- 在 starter 里补全按行读取与请求应答配对的逻辑
- 补全工具定义到模型工具参数的翻译，并加上服务端名前缀
- 补全聚合层的重名处理与单服务端失败降级
- 跑通一轮离线 Agent 循环，看到模型选中带前缀的工具并拿到结果

## 目录

- `servers/`：两个现成的服务端，零依赖、不联网、按 2026-07-28 规范手写。**它们不是练习，是你的连接对象**，读一遍就好。
  - `notes-server.mjs`：团队笔记库。有 `search` / `read_note` / `list_tags` 三个工具，`tools/list` **每页只回 2 个**，逼你把分页翻完。
  - `tickets-server.mjs`：工单系统。有 `search` / `close_ticket`，其中 `search` 和笔记库**撞名**；设 `SLOW_MS` 可以让它慢到必然超时。
- `starter/`：挖了 4 个练习点的起始代码，直接跑得起来，只是有 5 项自测是红的
- `solution/`：参考答案，9 项自测全绿
- `starter/src/` 与 `solution/src/` 各六个文件：
  - `protocol.ts`：协议常量与每条请求都要带的 `_meta`
  - `stdio-client.ts`：单个服务端的连接（拉起子进程、按行收发、请求应答配对）
  - `registry.ts`：聚合层（分页、命名前缀、反查表、失败隔离）
  - `agent.ts`：Agent 循环、离线的 `MockModel`、走 OpenRouter 的真模型
  - `selftest.ts`：验收编排，不是教学重点
  - `index.ts`：入口

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
MOCK=1 pnpm start     # 跑 9 项自测，逐项打印 ✅/❌ 后按结果退出
```

> `pnpm install --ignore-workspace` 可能以非 0 退出（pnpm 拦下了依赖的构建脚本），这不代表安装失败。看 `node_modules` 有没有生成，以及后面的 `pnpm typecheck` 和 `pnpm start` 正不正常。
>
> `starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含 `apps/*`），所以要加 `--ignore-workspace`。装完如果目录里多出一个 `pnpm-workspace.yaml`，删掉它。

`starter` 跑出来是 **4 项 ✅ / 5 项 ❌**，`solution` 是 **9 项全 ✅**。你的任务就是把那 5 个 ❌ 变绿。

想看一轮完整的 Agent 循环（而不是自测），给一个 `QUESTION`：

```bash
MOCK=1 QUESTION='帮我在笔记里搜一下分页是怎么讲的' pnpm start
```

有 OpenRouter key 的话，把 `.env.example` 复制成 `.env` 填上 `OPENROUTER_API_KEY`，去掉 `MOCK=1` 就是真模型：

```bash
QUESTION='工单里还有哪些没关的？' pnpm start
```

**真模型和离线模型走的是同一条链路**，区别只在 `agent.ts` 里换了一个 `ChatModel` 实现。这正是这个实验想让你看见的分层：MCP 那一侧的代码和你用哪个模型完全无关。

## 四个练习点

| 练习 | 在哪                             | 现在的样子                         | 对应哪几项自测   |
| ---- | -------------------------------- | ---------------------------------- | ---------------- |
| 1    | `stdio-client.ts` 的 `onLine`    | 只认 `result`，漏了 `error` 分支   | 第 2 项          |
| 2    | `registry.ts` 的 `listAllTools`  | 只取第一页                         | 第 3 项、第 9 项 |
| 3    | `registry.ts` 的 `modelToolName` | 直接用服务端上的原名               | 第 5 项、第 9 项 |
| 4    | `registry.ts` 的 `refresh`       | 没有 try/catch，一个服务端挂了全挂 | 第 8 项          |

## 验收标准

1. `starter` 里的 4 个练习点全部补完，`MOCK=1 pnpm start` 的 9 项自测全绿且退出码为 0
2. 第 3 项能看到 `notes` 的 3 个工具全在——说明你是靠 `nextCursor` 消失判断结束的，不是靠页大小猜的
3. 第 5 项能看到两个 `search` 各自还能反查回服务端上的原名 `search`；调用时发给服务端的是原名，不是带前缀的名字
4. 第 8 项能看到 `tickets` 进了 `down`、`notes` 的 3 个工具照常可用，且调用掉线服务端的工具返回的是 `isError` 结果而不是抛异常
5. `pnpm typecheck` 无输出（`strict` 下没有 `any`、没有隐式 any）

## 常见坑

- **靠切字符串把带前缀的名字拆回服务端与工具原名。** 工具原名里本来就允许有下划线（`read_note`、`close_ticket` 都是），截断加哈希之后更是拆不回来。唯一可靠的做法是留一张反查表，`lookup()` 就是干这个的。
- **拿服务端自报的 `serverInfo.name` 当前缀。** 规范明说它**不保证跨服务端唯一**，不能用来消歧。前缀必须来自客户端自己的配置（本课叫 `alias`），而且重复的别名要在启动时就报错。
- **只取 `tools/list` 的第一页。** 分页是服务端说了算的，你本机测的那个服务端一页发得完，不代表用户装的那个也发得完。判据只有一条：`nextCursor` 缺失才是结束。
- **把工具执行错误抛出去。** `isError: true` 的结果是**成功的响应**，它是给模型看的、让模型换个参数再试的。抛成异常等于把模型自我修正的机会掐掉，还顺手把整轮对话打断。反过来，协议错误（工具不存在、版本不支持）该抛就抛——那是程序的 bug，模型改不了。
- **忘了给请求设超时。** stdio 上服务端不回你就永远不回，`await` 会一直挂着。一个反应迟钝的服务端能把整个 Agent 卡死，这也是自测第 8 项存在的理由。
- **以为翻译是无损的。** MCP 的 `annotations`（`readOnlyHint` / `destructiveHint`）在模型 API 那边没有对应字段，翻译过去必然丢失。要不要弹确认框只能由你的客户端按注解自己判断——而且规范要求把注解当成**不可信输入**，它只是提示，不是权限。

## 许可

代码 MIT。
