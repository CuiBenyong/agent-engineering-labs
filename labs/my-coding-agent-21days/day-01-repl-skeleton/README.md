# D1 实验：一个能对话、能执行斜杠命令、能离线运行的 REPL 空壳与冻结的网关 provider

> 目标：把这门课要造的东西打出地基——三套协议（消息、工具、事件）、一层不绑厂商的网关 provider、
> 一个命令与对话分流的 REPL。今天它还只会说话，但后面二十天加的每一个能力都长在这几个文件上。

## 你会学到

- 起一个 readline REPL，把输入分成斜杠命令与对话两条路径
- 定义消息、工具、事件三套类型，以及一个只有流式方法的网关接口
- 实现网关 provider：手写请求体，读环境变量拿 base URL、key 与模型 id
- 实现离线剧本 provider，让 MOCK 等于 1 时不发任何网络请求
- 写自检入口，用一条命令逐项打印勾叉，证明四件事都成立

## 目录

```text
src/
  index.ts            入口：SELFTEST=1 跑自检，否则进 REPL
  config.ts           三个环境变量：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
  repl.ts             readline 循环 + 命令表（TODO(3) 在这里）
  render.ts           渲染层：只订阅 AgentEvent，今天故意"攒完再打"
  seed.ts             ★ 冻结：生成 work/repo 沙盒仓库
  mock-script.ts      今天的离线剧本
  selftest.ts         自检入口，四项断言
  kernel/
    types.ts          ★ 冻结：消息、工具、事件三套协议
    loop.ts           Agent Loop，今天只有一圈（TODO(4) 在这里）
    tools.ts          工具注册表，今天是空的
  providers/
    types.ts          ★ 冻结：ChatProvider 接口
    gateway.ts        OpenAI 兼容网关（TODO(1) 在这里）
    mock.ts           离线剧本引擎（TODO(2) 在这里）
    index.ts          ★ 冻结：唯一的 provider 选择点
```

★ 标记的文件是全课的地基，**后面每天都会原样复制它们，不要改**。
`gateway.ts` 与 `mock.ts` 今天是最小版本，D2 会把它们扩成正式版本并从那天起冻结。

- `starter/`：挖了四个练习点（`TODO(1)`–`TODO(4)`），typecheck 干净，自检会先亮两个叉
- `solution/`：参考答案，自检四项全绿

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env

# 验收入口：全课二十一天统一用这一条
MOCK=1 SELFTEST=1 pnpm start

# 交互着玩：管道喂输入也能跑（REPL 在 EOF 时正常退出）
printf '/help\n你是谁\n/exit\n' | MOCK=1 pnpm start

# 连真模型：任何 OpenAI 兼容网关都行
LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_API_KEY=sk-... LLM_MODEL=openai/gpt-4o-mini pnpm start
```

> `pnpm install --ignore-workspace` 可能以非 0 退出并打印 `Ignored build scripts: esbuild`，
> 这不代表安装失败——看 `node_modules` 有没有生成、`pnpm typecheck` 过不过就够了。

## 验收标准

- [ ] `MOCK=1 SELFTEST=1 pnpm start` 打印 `4/4 通过`
- [ ] `printf '/help\n/model\n/exit\n' | MOCK=1 pnpm start` 能看到命令表与当前网关
- [ ] 随便输一句话，能看到回答，末尾那行统计里增量个数大于 1
- [ ] 只改 `LLM_BASE_URL` 与 `LLM_MODEL`（不改一行代码）就能换到另一家网关
- [ ] `/seed` 之后 `work/repo` 下有四个文件，进去跑 `node --test` 会有一个用例失败

## 常见坑

- **`readline/promises` 的 `question()` 在管道喂输入时会挂住。** stdin 读到 EOF 后它在某些 Node 版本里既不 resolve 也不 reject，进程以 exit code 13 退出并报"未结算的顶层 await"。本实验改用 `node:readline` 的异步迭代器（`for await (const line of rl)`），EOF 时自然结束循环。
- **不带 `stream_options: { include_usage: true }` 就拿不到 usage。** 末尾那条带用量的事件不会出现，D12 与 D20 就没有数据可用。
- **模型 id 的形状随网关变化。** 有的网关要 `厂商/模型`，有的要模型原名。所以它必须是配置，代码里不许写死也不许假设。
- **首字延迟不是网速问题。** 会先想一大段再开口的模型，首字可能要十几秒。这就是明天要做流式渲染的原因——今天这版"攒完再打"把这个体感放大了。
