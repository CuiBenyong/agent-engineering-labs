# D3 实验：一个把本地 Markdown 笔记库暴露成资源的 MCP 服务端

> 目标：把一个普通的 Markdown 文件夹变成任何 MCP 客户端都能枚举、翻页、读取的资源集合，并配一个按标签汇总的提示模板。做完你会发现「资源」这层抽象底下什么都没有——就是一堆文件加一套 URI 约定，难的是分页、缓存提示和路径安全这些真实数据量下才会暴露的东西。

## 你会学到

- 读 solution 的资源注册代码，找到静态资源与 URI 模板两种写法
- 在 starter 里补全笔记目录的扫描与资源清单返回
- 为清单接口补上游标分页，确认第二页与第一页不重复
- 补全按标签检索的提示模板，并在返回里嵌入资源引用
- 用自测入口验证清单、读取、分页、提示模板四项

## 目录

```text
day-03-notes-resource-server/
├── notes/                 8 篇短笔记，starter 与 solution 共用这一份数据
├── starter/src/
│   ├── notes.ts           读取层：扫描目录、解析 frontmatter、URI 与 slug 互转（练习 1）
│   ├── pagination.ts      不透明游标的编解码与切页（练习 2）
│   ├── server.ts          五个方法的处理器：资源清单、模板、读取、提示列表、提示获取（练习 3、4）
│   └── index.ts           入口：自测编排与 stdio 常驻
└── solution/src/          同上，全部填好
```

`notes.ts`、`pagination.ts`、`server.ts` 三个文件的类型定义与函数签名在 starter 和 solution 里完全一致，对照着看只有函数体的差别。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
MOCK=1 SELFTEST=1 pnpm start   # 自测，逐项打印 ✅/❌
MOCK=1 pnpm start              # 常驻 stdio，供 Inspector 或你自己的客户端接
```

这个实验**完全离线**：数据来自 `notes/` 下的 Markdown，没有任何网络出口，也不需要 API key。`MOCK=1` 在这里只是「不依赖任何外部服务」的约定，两条路径跑的是同一份代码。

`pnpm install --ignore-workspace` 可能以非 0 退出并打印 `[ERR_PNPM_IGNORED_BUILDS]`，这是 pnpm 拦截了 esbuild 的构建脚本，依赖本身已经装好了。判断安装成不成功看后面的 `pnpm typecheck` 和自测能不能跑。

starter 原样跑是 **1 / 6 项通过**，四个练习点各对应一条红项；把练习做完就会变成 6 / 6，和 solution 一致：

```text
✅ 1. resources/list 第一页有内容且带 nextCursor —— 3 条，nextCursor=b2Zmc2V0OjM
✅ 2. 翻页无重复，最后一页不带 nextCursor —— 共 3 页 8 条，重复=false
✅ 3. resources/read 读到笔记正文 —— notes:///caching 正文 95 字
✅ 4. resources/templates/list 返回 uriTemplate —— uriTemplate=notes:///{slug}
✅ 5. prompts/get 的消息里含 resource_link，且按标签真的筛过 —— transport 命中 1 篇，mcp 命中 8 篇
✅ 6. 非法游标被拒绝而不是静默回第一页 —— 已拒绝
```

## 关于 SDK 版本

本实验用官方 JavaScript SDK 的**低层 `Server` 类**，不是 `McpServer`。原因是 `McpServer.registerResource` 一次只登记一条静态资源，不给你插手 `resources/list` 的机会，而今天要教的恰恰是分页。

另外请记住 D2 已经讲过的版本落差：`@modelcontextprotocol/sdk` 到 1.30.0 为止实现的仍是 `2025-11-25`，所以它在线上不会发 `resultType`，也没有 `server/discover` 与 `subscriptions/listen`。`ttlMs` 与 `cacheScope` 这类 2026-07-28 新增字段能原样透传出去（SDK 不校验结果里的额外字段），所以我们照新版的形状写，等 SDK 跟上就能直接用。Python 侧的 `mcp` 2.1.1 已经是 `2026-07-28` 了。

## 验收标准

1. `resources/list` 能翻完全部笔记，第二页与第一页不重复，最后一页不带 `nextCursor`
2. 非法游标被拒绝，而不是静默返回第一页
3. `resources/templates/list` 返回一条带 `uriTemplate` 的资源模板，`resources/read` 能读到笔记正文
4. `prompts/get` 按标签筛出笔记，并为每一篇附上一条 `resource_link`
5. `MOCK=1 SELFTEST=1 pnpm start` 六项全绿，退出码为 0

## 常见坑

- **把空字符串游标当成结束。** 规范写得很死：只有 `nextCursor` **缺失**才代表没有下一页，空字符串是一个完全合法的游标。starter 的 `encodeCursor` 恰好返回空串，所以你做完练习 1 之后会先撞上一个诡异现象：清单条数对了，翻页却在原地打转（`decodeCursor` 恒定返回 0，游标又不是 undefined，于是自测第 2 项报重复）。**先把练习 1 做完再看这一条，感受最深。**
- **游标编成明文偏移量。** 能跑，但等于邀请客户端去解析和伪造它。客户端 MUST NOT 对游标内容做任何判断，服务端也就不该给它可读的东西。base64url 包一层几乎不花成本。
- **扫描目录时忘了排序。** 分页游标编的是偏移量，`fs.readdir` 的返回顺序在不同文件系统上并不保证一致，顺序一变翻页就会串。规范也建议列表返回确定性顺序，好让客户端敢缓存。
- **`slugFromUri` 不校验就直接拼路径。** `notes:///../../etc/passwd` 会读到笔记库外面去。规范要求服务端 MUST 校验资源 URI、MUST 清洗路径以防目录穿越，所以这里用白名单正则而不是黑名单过滤。
- **`readResource` 的 `contents[0]` 直接取 `.text`。** 它是 text 与 blob 二选一的联合类型，TypeScript 会拦你；用 `'text' in content` 先窄化。

## 许可

代码 MIT。
