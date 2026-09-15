# D4 实验：3 provider 可切换模型层 + 自定义 system prompt

> 目标：把硬编码的模型调用拆成一层可替换的抽象——三个 provider 按配置切换，失败时按错误类型决定要不要换下一家，并用一段自己写的 system prompt 覆盖掉框架的默认人设。

## 你会学到

- 接入 3 个 provider（如 OpenRouter 上的不同模型），封装成统一的 callModel 接口
- 写一个自定义 system prompt，验证它确实覆盖了框架默认人设
- 模拟一个 provider 报错或超时，验证自动 fallback 到下一个
- 记录每次调用用的是哪个 provider，方便观察路由效果

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 先用 MOCK=1
MOCK=1 pnpm start     # 离线模拟，走完整降级链路
pnpm start            # 真模型
MOCK=1 pnpm start 帮我写首诗   # 业务外的问题：做练习 2 之前会跑题，写完能力边界后才会被挡回来
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

`MOCK=1` 下不需要任何 key：模拟层会按 `mockFailure` 字段制造超时、限流和 400，让你不用真的把账号打到限流，
就能验证 fallback 走通。

模拟层里的假模型还会**读你拼出来的 system prompt**：提示词里没声明能力边界（也就是 `starter/` 的默认人设）
就有问必答，业务外的问题照样跑题；声明了边界才会礼貌拒答。所以**离线也能看到 system prompt 生效前后的差别**。
注意它用的是关键词匹配，只是个演示级实现——真实模型靠的是提示词的语义约束，别把那段代码当生产做法。

## 验收标准

1. `MOCK=1 pnpm start` 打印出完整的降级路径，形如 `[降级路径] fast 超时（模拟） → strong 被限流（模拟） → backup 成功`。
2. 把 `fast` 的 `mockFailure` 从 `'timeout'` 改成 `'bad-request'`（模拟层会抛 `new ProviderError(..., 400)`），
   重跑后确认程序打印 `[不重试] …` 并**直接抛出**，没有再去试 `strong` 和 `backup`。验证完改回 `'timeout'`。
3. **先后跑两次，看到同一条命令的输出变了**：在 `starter/` 里先原样跑 `MOCK=1 pnpm start 帮我写首诗`，
   它会兴致勃勃地给你写诗（默认人设不设防）；做完练习 2 把能力边界写进 system prompt，再跑同一条命令，
   它改口成「我只负责订单、退换货和物流」这类拒答。**从跑题变成拒答**，这个变化才是 system prompt 生效的证据。
   去掉 `MOCK=1` 连真模型，结论应当一致。
4. 每轮结束打印 `[usage] provider=… tokens=…`，换几个问题连问五轮，能看出命中分布。
5. `pnpm typecheck` 通过，没有 `any`。

## 常见坑

- **超时一刀切**：三个 provider 用同一个超时值，会把本来能成功的强模型请求提前掐死。超时必须按 provider 分别配。
- **所有错误都重试**：400（请求体不合法）、403（被安全策略拦截）是你自己请求写错了，换一家还是错，白花两倍时间和钱。分类要在重试之前做。
- **只盯着 4xx/5xx 这条粗线**：402（余额不足）和 404（模型被下线或改名）都是 4xx，但**应该** fallback——
  判断依据是「换一家有没有可能变好」，不是状态码的首位数字。401 则取决于三家是不是共用同一把 key。
- **以为不写 system prompt 也没事**：框架会替你填一段默认人设，它有问必答、不认业务边界。
  `starter/` 原样跑一次「帮我写首诗」就能看到这个坑长什么样。
- **忘了把当前时间塞进 system prompt**：模型没有时钟，问它「三天前下的单」它只能瞎猜。
- **`shouldTryNext` 里直接用 `err.message` 做字符串匹配**：错误信息一改逻辑就崩，应该带结构化的 `status` 字段。
