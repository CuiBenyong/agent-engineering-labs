# Agent 工程实验集

> 129 个实验，覆盖 13 门 AI 工程课程。其中 **112 个是能跑的代码**，全部支持离线运行、不需要 API key；另外 17 个是文档型（提示词模板、检查表、`SKILL.md`），本来就不需要代码。
>
> [English](./README.en.md) · [实验索引](./INDEX.md) · [配套课程](https://course.front-end-js.top)

这是[逐日AI](https://course.front-end-js.top)课程的配套代码。每一天的正文都对应一个实验，代码全在这里，MIT 许可，随便用。

## 三十秒跑起来

每个实验都是自包含的包，不依赖仓库里的其它东西：

```bash
git clone https://github.com/CuiBenyong/agent-engineering-labs.git
cd agent-engineering-labs/labs/my-coding-agent-21days/day-01-repl-skeleton/solution

pnpm install --ignore-workspace --config.strict-dep-builds=false
MOCK=1 pnpm start
```

两个参数都有原因，不是凑数的：

- **`--ignore-workspace`**：每个 lab 有自己的 `package.json`，不加的话 pnpm 会往上找 workspace 配置然后装错东西。
- **`--config.strict-dep-builds=false`**：pnpm 11 起 `strictDepBuilds` 默认为 true，于是 `esbuild`（`tsx` 的传递依赖）的构建脚本被忽略时，会从一条警告升级成**致命错误**，install 直接返回非 0。加这个参数把它降回警告。用 pnpm 10 或更早的版本不需要它，加了也无害。

（每个 lab 的 `.npmrc` 里还有一条 `verify-deps-before-run=false`，同一个问题的另一半：`pnpm start` 之前会重跑一次 install 检查，不关掉的话即使装好了也起不来。）

[INDEX.md](./INDEX.md) 里每个实验都标了类型，「文档型」那些没有 `package.json`，直接读 `solution/` 下的 Markdown 即可。

## 为什么都能离线跑

**`MOCK=1` 是全部实验的统一开关。** 打开它之后，模型调用走本地剧本，不发任何网络请求、不花一分钱、每次输出都一样。

这不是为了省钱做的妥协，是刻意的设计：

- **可复现。** 真实模型每次回答都不同，一个每次结果都不一样的教学实验没法验证对错。
- **不卡在第一步。** 学 Agent 的人不该先被「去哪申请 key、怎么充值」挡住。
- **可以做变异检验。** 剧本固定，你才能把某个防御关掉、看指标是不是真的退化——好几门课的实验就是靠这个证明「防御真的起作用了」，而不是碰巧跑绿。

想换成真实模型，配好 `.env`（每个 lab 都有 `.env.example`）去掉 `MOCK=1` 即可。

## 每个实验长什么样

```
day-01-annotate-json-rpc/
├── README.md      # 要做什么、怎么验收、手动检查清单
├── starter/       # 骨架，留着 TODO，测试是红的
└── solution/      # 参考实现，测试全绿
```

**先动 `starter/`，卡住了再看 `solution/`。** 直接读答案学不到东西——这些实验的价值恰恰在于卡住的那几分钟。

有些 lab 还带 `docker-compose.yml`（需要 Postgres 或 Redis 的那些）。端口是按天号错开的，同时跑几个也不会撞。

## 代码说明「做了什么」，正文解释「为什么」

这个仓库只有代码。每个实验为什么这么设计、坑在哪、当初试过哪些走不通的方案，写在对应的课程正文里——[INDEX.md](./INDEX.md) 里每一行都给了直达链接。

举几个实际的例子，这类结论代码本身是看不出来的：

- 为什么归并 `tool_calls` 分片必须按 `index` 建字典而不能往数组里 push（实测同一个模型同一天两次运行的 index 起点不同）
- 为什么只报 ASR 的安全防御方案一律不可信（把 Agent 改成什么都不做，ASR 就是 0）
- 为什么本地 mock 下「每个增量一次 setState」根本不产生渲染风暴（React 18 的自动批处理，实测 174 个增量只渲染 6 次）

课程目前**限时全部免费开放**，不用付费也不用注册。

## 索引

[INDEX.md](./INDEX.md) — 129 个实验按课程分组，每行带对应章节的链接。

| 课程 | 实验数 |
|---|---|
| [30 天从前端工程师到 Agent 工程师](https://course.front-end-js.top/learn/agent-30days) | 27 |
| [21 天手搓一个 Coding Agent](https://course.front-end-js.top/learn/my-coding-agent-21days) | 21 |
| [14 天 RAG：从检索到可信回答](https://course.front-end-js.top/learn/rag-14days) | 14 |
| [14 天用 Agent 搭一条 AI 短剧生产线](https://course.front-end-js.top/learn/ai-drama-pipeline) | 14 |
| [7 天 MCP：把工具接进任何 Agent](https://course.front-end-js.top/learn/mcp-7days) | 7 |
| [7 天 Agent Skills](https://course.front-end-js.top/learn/agent-skills-7days) | 7 |
| [7 天前端 Agent 体验](https://course.front-end-js.top/learn/frontend-agent-ux-7days) | 7 |
| [7 天 Agent 评估与可观测](https://course.front-end-js.top/learn/agent-evals-7days) | 7 |
| [5 天提示词工程零基础](https://course.front-end-js.top/learn/prompt-engineering-5days) | 5 |
| [Claude 高效使用](https://course.front-end-js.top/learn/claude-mastery) | 5 |
| [Codex 与 OpenAI Agents SDK 高效使用](https://course.front-end-js.top/learn/codex-mastery) | 5 |
| [5 天上下文工程](https://course.front-end-js.top/learn/context-engineering-5days) | 5 |
| [5 天 Agent 安全](https://course.front-end-js.top/learn/agent-security-5days) | 5 |

## 技术栈

TypeScript + Node 22 为主。刻意**不用 Agent 框架**——工具循环、SSE 解析、MCP 协议、事件流渲染全是手写的，因为 Agent 的复杂度恰好都藏在框架封起来的那几层里。少数实验用到 Next.js（前端体验课）、Postgres / pgvector（RAG 课）、ffmpeg（短剧课）。

## 反馈

实验跑不起来、README 写得不清楚、或者发现了 bug，欢迎开 issue。

代码以 [MIT](./LICENSE) 发布。课程正文不在此列，版权另有归属。

相关：[Agent 工程师学习路线图](https://github.com/CuiBenyong/agent-engineering-roadmap) — 这些课该按什么顺序学。
