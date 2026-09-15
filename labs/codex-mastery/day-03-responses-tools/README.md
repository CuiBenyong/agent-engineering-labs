# D3 实验：带内置工具的 Responses API 最小脚本

> 目标：用 OpenAI 官方 SDK 走一遍 Responses API 的三种典型用法——函数调用的「请求 → 执行 → 回填」来回、web search 内置工具的引用来源、`json_schema` 严格模式的结构化输出与 refusal 分支。做完你会知道 Codex 这类成品底下那层接口长什么样。

## 你会学到

- 用 responses.create 发第一个请求，打印 output_text，对照 Chat Completions 的写法
- 声明一个查本地 TODO 列表的 function 工具，处理 function_call 并回填 function_call_output
- 加上 web_search 内置工具，打印回答里的 url_citation 注解
- 用 zodTextFormat 或 pydantic 拿结构化输出，故意触发一次 refusal 看分支
- 用 previous_response_id 串起两轮对话，再改成自己维护 input 数组对比

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑（但会看到「还没做完」的现象）
- `solution/`：参考答案

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENAI_API_KEY 与 OPENAI_MODEL；没有 key 先用 MOCK=1

MOCK=1 pnpm start "还有哪些没做完"             # 函数调用来回
MOCK=1 pnpm start --search "Express 校验库"    # web search
MOCK=1 pnpm start --structured "审查这段 diff" # 结构化输出
MOCK=1 pnpm start --structured "帮我删库"      # 触发 refusal 分支
pnpm start "还有哪些没做完"                    # 真模型
```

模型 id 不写死在代码里：`OPENAI_MODEL` 以 [官方文档](https://developers.openai.com/api/docs) 当前推荐的模型为准。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。安装时若打印 `ERR_PNPM_IGNORED_BUILDS`
> 不是失败，看 `node_modules` 是否生成、`pnpm typecheck` 是否通过。

这是**一次性脚本**（读 `process.argv`），不是 REPL，直接带参数跑，不要用管道喂输入。

## 验收标准

1. `MOCK=1 pnpm start "还有哪些没做完"` 能看到一次完整的函数调用来回：模型请求 `list_todos`，脚本回填，最终回答里出现 TODO 标题。
2. 带上 `--search` 时回答后面列出了至少一条 `url_citation` 来源（MOCK 下是固定的假来源）。
3. `--structured` 模式下输出的是解析好的对象，故意输入一段会被拒绝的内容时打印的是「模型拒绝了」而不是报错栈。
4. 去掉 MOCK 用真 key 跑一次，观察 `previous_response_id` 串起来的第二轮不需要重发历史。

## 常见坑

1. **`call_id` 没对上。** 回填的 `function_call_output` 必须用模型给的那个 `call_id`，一轮请求了几个函数就回填几个，少一个模型会等不到结果直接报错。
2. **把 refusal 当成解析失败。** 模型拒答时返回的是 `refusal` 类型的内容块，`output_parsed` 为空；不先检查它，`Review.parse` 会抛一个看起来像 schema 写错了的 zod 错误。
3. **strict 模式忘了 `additionalProperties: false`。** `strict: true` 要求 schema 里每个对象都关掉额外字段，否则请求直接 400。
4. **`OPENAI_MODEL` 没配。** 本实验故意不给默认模型，缺了会明确报错；不要为了省事把某个型号写死进代码。
