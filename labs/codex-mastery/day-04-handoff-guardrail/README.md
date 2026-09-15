# D4 实验：双 Agent handoff 加一个 guardrail 的示例

> 目标：用 OpenAI Agents SDK 搭一个「分诊台 + 两位专家」的最小多 Agent 系统，给分诊台挂一个输入护栏，再用 session 跑两轮对话。做完你会知道 handoff 交出去的是什么、护栏挂错位置为什么不生效、多轮记忆放在谁手里。

## 你会学到

- 写一个只会回答 TODO API 问题的 Agent，加一个查接口清单的函数工具
- 拆成分诊 Agent 与两个专家 Agent，用 handoffs 交接，打印 lastAgent 验证路由
- 给分诊 Agent 加一个输入侧 guardrail，拦住与项目无关的请求并捕获 tripwire
- 用 session 跑两轮对话，验证第二轮记得第一轮
- 在 MOCK=1 下跑通全部路径，再去掉 MOCK 在追踪面板里看一次真实运行

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑（但所有问题都由 triage 自己回答、护栏不生效、第二轮不记得第一轮）
- `solution/`：参考答案

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENAI_API_KEY 与 OPENAI_MODEL；没有 key 先用 MOCK=1

MOCK=1 pnpm start "title 为空应该返回什么"   # 期望 lastAgent=validation_expert
MOCK=1 pnpm start "测试之间怎么隔离状态"      # 期望 lastAgent=testing_expert
MOCK=1 pnpm start "帮我写一首情诗"            # 期望被护栏拦下，退出码 0
MOCK=1 pnpm start --session                   # 两轮对话，第二轮引用第一轮的事实
pnpm start "title 为空应该返回什么"           # 真模型，跑完去 Traces 面板看交接发生在哪一轮
```

模型 id 不写死：`OPENAI_MODEL` 以 [官方文档](https://developers.openai.com/api/docs) 当前推荐的模型为准，不设置时走 SDK 默认。追踪默认开启，处理敏感数据时设 `OPENAI_AGENTS_DISABLE_TRACING=1`。

> 依赖说明：除 `@openai/agents` 外还直接依赖 `@openai/agents-core`，因为 `RECOMMENDED_PROMPT_PREFIX`
> 从 `@openai/agents-core/extensions` 导入，pnpm 的严格依赖解析不允许引用间接依赖。
>
> `starter/` 与 `solution/` 都不属于仓库根 pnpm workspace，`pnpm install` 时要加 `--ignore-workspace`。
> 安装时打印 `ERR_PNPM_IGNORED_BUILDS` 不是失败，看 `pnpm typecheck` 是否通过。

这是**一次性脚本**（读 `process.argv`），不是 REPL，直接带参数跑。MOCK 模式不调模型，但护栏判断、路由、session 读写都真实执行——MOCK 验证的是你的编排逻辑，不是模型。

## 验收标准

1. `MOCK=1 pnpm start "title 为空应该返回什么"` 输出里 `lastAgent` 是 `validation_expert`；换成测试相关的问题时是 `testing_expert`。
2. `MOCK=1 pnpm start "帮我写一首情诗"` 打印的是护栏拦截的友好提示，不是异常栈；程序退出码为 0。
3. `--session` 模式连问两句，第二句的回答里引用了第一句给的事实。
4. 去掉 MOCK 跑一次真实运行，在 Traces 面板里能找到这条 trace，并看到 `transfer_to_validation_expert` 那一步。

## 常见坑

1. **护栏挂在专家 Agent 上。** 输入护栏只在链条的第一个 Agent 上跑，挂在 `validation_expert` 上永远不会执行。挂在 `triage` 上。
2. **护栏太严。** 关键词白名单一开始漏了「为空」「返回」，导致「title 为空应该返回什么」这个正常问题被拦——护栏上线前要用一批正常请求做回归，误拦率是必看指标。
3. **忘了 `maxTurns`。** 交接加工具调用很容易让一次 run 转很多圈，不设上限一个误读工具结果的 Agent 会一直烧钱；本实验设了 6。
4. **`@openai/agents-core` 没装成直接依赖。** 只装 `@openai/agents` 时 `import ... from '@openai/agents-core/extensions'` 会报「找不到模块」。
