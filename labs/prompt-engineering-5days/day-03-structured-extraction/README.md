# D3 实验：结构化抽取脚本：把一段需求描述抽成固定字段的 JSON，支持离线模拟

> 目标：写一个脚本，把「POST /todos 的 title 必填不超过 200 字符，失败返回 400」这类自然语言需求，抽成程序能直接消费的固定字段 JSON。
> 它是本课第一个可以跑的实验，重点不在调 API，而在三件事：**schema 约束输出形状、提示词写成带变量的模板、解析失败时的校验 → 重试 → 降级**。

## 你会学到

- 跑通 solution，用 MOCK=1 看清输入的需求描述与输出 JSON 的对应关系
- 在 starter 里补全 schema 定义，让字段、类型与枚举与文档一致
- 把系统提示改写成带变量的模板，用语言变量切换中英文输出
- 补全解析失败时的校验与一次重试，故意喂一条坏输入验证兜底生效
- 去掉 MOCK=1，用真模型跑同一批输入，对比字段是否稳定

## 目录

- `starter/`：挖了 4 个练习点的起始代码，`MOCK=1` 下可以直接跑（但第三条需求的坏输出会被放过——这就是练习 3 要修的）
- `solution/`：参考答案

两个目录的类型定义、函数签名、命令行交互完全一致，只有四个练习点不同。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 ANTHROPIC_API_KEY（或 PROVIDER=openai + OPENAI_API_KEY + OPENAI_MODEL）；没有 key 先用 MOCK=1
MOCK=1 pnpm start                 # 离线模拟：跑内置的三条需求
MOCK=1 OUTPUT_LANG=en pnpm start  # 同一份提示词，summary 换成英文
pnpm start "PATCH /todos/:id 的 dueDate 可选，必须是 ISO 日期"   # 真模型 + 自定义需求
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。安装可能以非 0 退出（`ERR_PNPM_IGNORED_BUILDS`），
> 那是 pnpm 拦了依赖的构建脚本，不影响运行；如果目录里冒出一个 `pnpm-workspace.yaml`，删掉它。

`MOCK=1` 下不需要任何 key：模型出口返回固定的抽取结果，第三条含「乱码」的需求会**先返回一个 `failureStatus` 是字符串的坏对象**，用来演示校验与重试。

两家 provider 拿结构化输出的方式不同，代码里各一个函数：Anthropic 用「强制调用一个工具」，工具的 `input_schema` 就是 schema；OpenAI 用 Responses API 的 `json_schema` 严格模式。OpenAI 的模型 id 从 `OPENAI_MODEL` 读，以官方文档当前推荐为准。

## 验收标准

1. `MOCK=1 pnpm start` 跑 starter，三条需求都输出一个完整的 JSON，`validations` 里每一项都有 `field / type / required / rule` 四个键。
2. `MOCK=1 OUTPUT_LANG=en pnpm start`，三条需求的 `summary` 都变成英文，其余字段不变——说明语言是模板变量而不是另一份提示词。
3. 第三条需求（含「乱码」）的输出里能看到一行「第 1 次校验失败：failureStatus 必须是 4xx 整数」，随后拿到一个 `failureStatus` 为数字 400 的正确结果——说明校验与重试都生效了。
4. 把 `validateSpec` 里的 4xx 检查临时改成「必须是 5xx」再跑第三条，能看到「两次都没通过校验，已降级为 null」而不是报错崩掉。
5. （有 key 的话）去掉 `MOCK=1` 跑三次同一条需求，`endpoint / method / failureStatus` 三个字段三次完全一致。

## 常见坑

1. **schema 写了却没有把字段放进 `required`，或者漏了 `additionalProperties: false`。** 两家 API 的严格模式都会因此直接报 400，错误信息还不太好读。规律是：严格模式下每个 object 的所有 properties 都必须出现在 required 里。
2. **以为 schema 通过了就不用再校验。** schema 只能说「failureStatus 是整数」，说不了「必须是 4xx」；只能说「rule 是字符串」，说不了「不能为空」。业务规则永远要在代码里再查一遍，这就是为什么 `validateSpec` 和 schema 是两份东西。
3. **重试时原样重发。** 模型上一次输出错了，原样再发一遍大概率得到同样的错。要把校验的错误列表拼回用户消息，让它知道改哪里。
4. **降级时抛异常。** 抽取失败是正常业务分支，不是程序错误。返回 `null` 让调用方决定跳过还是人工处理；抛异常会让一条坏需求把整批任务打断。
