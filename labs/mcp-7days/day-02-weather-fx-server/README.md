# D2 实验：一个含天气与汇率两个工具的 stdio MCP 服务端

> 目标：用官方 SDK 写出你的第一个真服务端，把描述、输入 schema、输出 schema、工具注解和两类错误一次性配齐。做完它，任何 MCP 客户端都能加载你这个进程并把两个工具交给模型使用。

## 你会学到

- 读 solution 的服务端骨架，找到工具注册、schema 声明与传输启动三处
- 在 starter 里补全天气工具的输入 schema 与结构化返回
- 补全汇率工具，并让参数非法时返回执行错误而不是抛异常
- 给两个工具各写一组注解，说明为什么汇率查询是只读且幂等的
- 用自测入口跑一遍，确认工具清单、正常调用、错误调用三项都通过

## 目录

- `starter/`：挖了 5 个练习点的起始代码，`MOCK=1` 下可以直接跑，自测会有 5 项 ❌
- `solution/`：参考答案，自测 7 项全 ✅
- `src/data.ts`：两个「网络出口」函数（天气、汇率），`MOCK=1` 时走内置假数据表
- `src/server.ts`：**你要改的就是这个文件**，工具都注册在这里
- `src/selftest.ts`：自测编排，用 SDK 的内存传输把客户端和服务端接在一个进程里
- `src/index.ts`：入口，按环境变量决定跑自测还是常驻 stdio

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace

# 验收入口：自己给自己发请求，逐项打印 ✅/❌，跑完退出
MOCK=1 SELFTEST=1 pnpm start

# 常驻模式：走 stdio，供 Inspector 或任何 MCP 客户端接入
MOCK=1 pnpm start
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。
>
> `pnpm install --ignore-workspace` 结尾会打印 `[ERR_PNPM_IGNORED_BUILDS]` 并以非 0 退出，
> **这不是失败**——依赖已经装好了，pnpm 只是拦下了 esbuild 的构建脚本。以 `pnpm typecheck`
> 和自测能不能跑通为准。

**这个实验不需要任何 API key，也完全不联网。** `.env.example` 里那个 `OPENROUTER_API_KEY` 是脚手架
带的，本实验用不到。天气与汇率都来自 `src/data.ts` 里的内置假数据表；真实实现会在
`fetchWeather` 与 `fetchRate` 里打第三方 API，那两个函数已经把真实分支写出来了（读
`WEATHER_API_URL` / `FX_API_URL`），去掉 `MOCK=1` 就会走它。

## 关于 SDK 版本：规范和实现现在对不上

2026-09-06 实测：`npm view @modelcontextprotocol/sdk version` 是 **1.30.0**，它的
`LATEST_PROTOCOL_VERSION` 仍然是 **`2025-11-25`**，包里搜不到 `resultType`，也没有
`server/discover`。Python 侧 `mcp` 的 **2.1.1** 已经跟上 **`2026-07-28`**，`mcp.types`
里能找到 `DiscoverRequest`、`InputRequiredResult`、`SubscriptionsListenRequest`。

所以本实验用 JS SDK 写出来的服务端，**线上跑的是上一版协议的报文**。规范怎么定，看 D1 那份手写
报文；SDK 现在怎么实现，看这里。两者不一致的地方本实验碰到一处，见「常见坑」第 4 条。

## 验收标准

1. `tools/list` 返回 `get_weather` 与 `convert_currency` 两个工具，且都带输入与输出 schema
2. `get_weather` 正常调用返回 `structuredContent`，未知城市返回 `isError` 且文案里列出了可用城市
3. `convert_currency` 把 100 USD 正确换成 712 CNY，金额为负或币种未知时返回对模型有用的 `isError`
4. 两个工具都声明了 `readOnlyHint` 与 `idempotentHint` 注解
5. `MOCK=1 SELFTEST=1 pnpm start` 在 solution 下 7 项全 ✅ 并以退出码 0 结束

## 常见坑

1. **往 stdout 打日志。** stdio 传输规定服务端 stdout 里不能出现任何非 MCP 消息，一个
   `console.log` 就会让客户端解析失败，而且报错信息通常只是「JSON 解析错误」，根本指不到你那行。
   `src/index.ts` 里那句启动提示走的是 `process.stderr.write`，就是这个原因。
2. **未知输入直接 `throw`。** SDK 确实会把抛出的异常兜成一条 `isError` 结果，看起来「也没崩」。
   但模型拿到的是一句 `查不到`，它不知道该换成哪个城市重试。starter 的练习 3 就是这个反例，
   自测第 4 项专门盯它。**执行错误的文案是写给模型看的，要把可选值列出来。**
3. **不做参数校验，让 NaN 一路传下去。** starter 里 `amount: -5` 会安安静静返回
   `converted: -35.6`——没有报错、没有 `isError`，模型会把这个负数当成正确答案。这比崩掉危险得多。
   自测第 6 项断言错误文案里不能出现 SDK 的 `validation error`，就是为了堵住「靠输出 schema 校验
   兜底」这种假处理。
4. **未知工具名的行为，SDK 和规范不一致。** 规范说未知工具是协议错误，要回 JSON-RPC 的
   `error`（`-32602`）。但 SDK 1.30.0 的 `McpServer` 会自己 `catch` 掉这个 `McpError`，把它压成
   一条 `isError: true` 的结果，文案里保留 `MCP error -32602: Tool xxx not found`。所以你在客户端
   侧看到的是 `isError`，不是异常。自测第 7 项按 SDK 的实际行为断言，并在注释里写明了这处偏差。

## 许可

代码 MIT。
