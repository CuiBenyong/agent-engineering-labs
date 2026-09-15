# D7 实验：一个可发布的 MCP 服务端模板与配套工具评估脚本

> 目标：把一个能跑的服务端变成一个**能长期维护**的服务端。三件事：给工具写一份三类齐全的评估集（正例、边界、诱导误选），给调用补上耗时与错误计数，再用一个静态检查挡住那些「发出去就改不了」的元数据错误。做完这一份，你手上就有一个可以直接改成自己项目的模板。

## 你会学到

- 读 solution 的模板结构，找到服务端、评估脚本与发布配置三处
- 在 starter 里补全评估脚本的用例加载与断言
- 补上一组诱导误选的负例，确认它们被判为不该调用
- 给服务端补上调用计时与错误计数两个指标
- 按发布检查表核对包配置，跑一次打包预演

## 目录

- `starter/`：挖了 4 个练习点的起始代码，直接跑得起来，只是有 4 项自测是红的
- `solution/`：参考答案，7 项自测全绿
- 两边的 `src/` 各七个文件加一份评估集：
  - `protocol.ts`：协议常量与两个响应构造器
  - `server.ts`：三个工具（搜索、按 slug 读、新建），**刻意做得容易混淆**，好让评估集有东西可评
  - `metrics.ts`：按工具聚合的调用次数、错误数与 P50 / P95
  - `evals/cases.json`：评估集本体
  - `eval.ts`：跑分器（加载、断言、汇总）
  - `selector.ts`：「选工具」这一步的三种实现——离线规则、故意选错（自测用）、真模型
  - `publish-check.ts`：发布前的静态核对
  - `selftest.ts`：验收编排，不是教学重点
- 两边的根目录还有 `server.json`：注册表要的那份元数据

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
SELFTEST=1 MOCK=1 pnpm start   # 跑 7 项自测，逐项打印 ✅/❌ 后按结果退出
MOCK=1 pnpm eval               # 只跑评估集，打印跑分表
```

> `pnpm install --ignore-workspace` 可能以非 0 退出（pnpm 拦下了依赖的构建脚本），这不代表安装失败。装完如果目录里多出一个 `pnpm-workspace.yaml`，删掉它。

`starter` 跑出来是 **3 项 ✅ / 4 项 ❌**，`solution` 是 **7 项全 ✅**。

有 OpenRouter key 的话，把 `.env.example` 复制成 `.env` 填上，去掉 `MOCK=1` 就是**用真模型跑评估**：

```bash
pnpm eval
```

这时跑分表量的就不再是那套关键词规则，而是真模型在你这份工具描述下的选择准确率。**改一句描述再跑一次**，你会立刻看到评估集的价值。

服务端本体照常可以被真实客户端加载：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"分页"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}' | npx tsx src/index.ts
```

想看指标端点，加一个环境变量（端口按本课口径取 3037）：

```bash
METRICS_PORT=3037 pnpm start
curl -s http://127.0.0.1:3037
```

**指标走 HTTP，MCP 走 stdio，两者互不干扰**——这也是为什么服务端的日志只能打到 stderr。

## 四个练习点

| 练习 | 在哪                                 | 现在的样子                             | 对应哪项自测 |
| ---- | ------------------------------------ | -------------------------------------- | ------------ |
| 1a   | `eval.ts` 的 `loadCases`             | 什么都不校验                           | 第 2 项      |
| 1b   | `eval.ts` 的 `judge`                 | 把 `expected` 为 null 当成「随便都行」 | 第 5 项      |
| 2    | `evals/cases.json`                   | 缺了整整一类：诱导误选                 | 第 2、5 项   |
| 3    | `server.ts` 的 `tools/call` 分支     | 一个指标都没记                         | 第 6 项      |
| 4    | `publish-check.ts` 的 `checkPublish` | 只查了两个字段存在与否                 | 第 7 项      |

练习 1b 和练习 2 是一对：**先把断言修对，再补负例**。顺序反了的话，你补的负例会全部假绿——这正是自测第 5 项要用一个「故意选错的选择器」再跑一遍的原因，它验的不是选择器，是**你的断言真的在起作用**。

## 打包预演与发布

这个模板不会真的发到 npm（`package.json` 里留着 `"private": true`），但整条路可以预演：

```bash
pnpm build            # 编译到 dist/，顺带把评估集拷过去
npm pack --dry-run    # 看清单里有没有 dist、README.md、server.json
```

真要发的时候，顺序是固定的三步，**一步都不能换**：

1. 改 `package.json`：删掉 `private`，把 `name` 改成你的包名，`mcpName` 改成 `io.github.你的用户名/服务端名`。
2. 先发 npm（注册表只存元数据，不存产物）：`npm publish --access public`。
3. 再发注册表：`mcp-publisher login github` 然后 `mcp-publisher publish`。

`server.json` 里那个 `name` **必须**和 `package.json` 的 `mcpName` 一字不差——注册表靠它确认「这个 npm 包确实是这个服务端」。用 GitHub 认证时，名字还必须以 `io.github.你的用户名/` 开头，否则会被拒。这几条正是练习 4 要你写进 `checkPublish` 的。

## 验收标准

1. `starter` 里的 4 个练习点全部补完，`SELFTEST=1 MOCK=1 pnpm start` 的 7 项自测全绿且退出码为 0
2. 评估集至少 9 条、三类齐全，且**先修断言再补负例**——第 5 项里「故意选错的选择器」那一栏必须是 0
3. 第 6 项能看到三条路径都被记了：工具不存在、`isError` 为真、以及抛异常，少记一条这项就不绿
4. 第 7 项在你把 `mcpName` 改坏之后能报出「与 server.json 的 name 不一致」
5. `pnpm build` 与 `npm pack --dry-run` 都能跑通，清单里有 `dist`
6. `pnpm typecheck` 无输出

## 常见坑

1. **评估集只有正例。** 通过率 100%，看着很好，其实一条都没测到「不该调的时候调了」——而线上大多数投诉恰恰是过度触发。三类缺一不可，这也是 `loadCases` 要用 `throw` 而不是 `console.warn` 的原因：评估集是防线，防线坏了必须停下来。
2. **把 `expected: null` 当成「随便都行」。** 这是评估集最常见的写法错误，它让负例永远绿，比没有负例更糟——因为你以为自己测了。
3. **只记成功路径的指标。** 漏掉 `isError` 为真那一条，线上的错误率曲线会比真实情况好看，而好看的假曲线比没有曲线更危险。
4. **在 stdout 上打日志。** 服务端跑在 stdio 上时，stdout 只能放协议消息。指标要看就另开一个 HTTP 端点，日志一律走 stderr。
5. **改了工具描述不跑评估。** 描述是模型选工具的唯一依据，**改一句描述就是一次行为变更**，它不会让任何单元测试变红，只会让线上选中率悄悄掉几个点。这也是为什么评估集要能一条命令跑完。
6. **`server.json` 的版本写成范围。** `^1.2.3`、`1.x` 这类会被注册表直接拒收。而且版本号一旦发布就不能改、不能复用，所以打错一个字只能往上加一个版本。
7. **忘了把 `evals/` 拷进 `dist`。** `tsc` 只编译 TypeScript，不搬 JSON。`build` 脚本里那句 `cp -R src/evals dist/evals` 就是干这个的，删了它编译能过、跑起来直接找不到文件。

## 许可

代码 MIT。
