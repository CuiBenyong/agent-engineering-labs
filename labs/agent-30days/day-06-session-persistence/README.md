# D6 实验：会话持久化 + 自动压缩

> 目标：给 Agent 装上一份能跨进程活下来的记忆——每条消息按 JSONL 只追加落盘，历史涨到预算七成时自动摘要压缩，重启后从磁盘恢复继续对话，还能从历史任意一条分叉出一条互不干扰的新会话。

## 你会学到

- 把每轮对话的消息落盘持久化（先用文件或简单存储即可）
- 实现一个上下文压缩函数：超过阈值时把早期消息摘要成一条
- 重启程序后从持久化数据恢复会话，验证能继续对话
- 实现会话分叉：从历史某一条消息开始，新建一个独立会话
- 对比压缩前后的 token 用量

## 目录

- `starter/`：挖了练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 先用 MOCK=1
MOCK=1 pnpm start     # 五步演示：灌历史 → 自动压缩 → 模拟重启恢复 → 分叉 → 校验父会话未被改动
pnpm start            # 真模型
```

跑完演示后还有三条命令可以手动验证，每一条都是**一个独立的进程**——这正是"跨重启恢复"的证据：

```bash
MOCK=1 pnpm start chat "我住上海，帮我记一下"     # 在会话 main 上追加一轮
MOCK=1 pnpm start chat "刚才我说我住哪？"          # 新进程，从磁盘恢复后继续对话
MOCK=1 pnpm start fork 4                          # 从第 4 条分叉，打印新会话 id
MOCK=1 pnpm start chat "换个方向问" --session=s-xxxxxxxx
MOCK=1 pnpm start show main                       # 看父会话有没有被分叉改动
```

会话文件落在运行目录下的 `.sessions/`：`main.jsonl` 是只追加的原始历史，
`main.meta.json` 是元信息（父会话、分叉点、压缩水位、滚动摘要）。
`MOCK=1` 下不需要任何 key：模拟层会造出带工具调用的多轮对话，让历史迅速涨到阈值，
不用真花钱聊三十轮就能看到压缩触发。假模型只从"实际发给模型的那一份"里找答案，
所以摘要有没有保住"我住上海"这条事实，问一句就知道。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 pnpm start` 打印出压缩前后的对比，形如
   `[压缩] 33 条 / 3135 token → 10 条 / 916 token（降幅 71%）`。
2. 连着跑两次 `MOCK=1 pnpm start chat "…"`（两个独立进程），第二次打印
   `[恢复] 从磁盘读到 N 条消息` 且 N 大于 0——证明历史真落了盘。
3. `MOCK=1 pnpm start fork 4` 分出新会话并用 `--session=` 在它上面追加一轮后，
   `MOCK=1 pnpm start show main` 显示父会话条数一条没变。
4. 打开 `.sessions/main.jsonl`，能看到一行一条消息、只追加不改写，`tool` 那条也在。
5. `pnpm typecheck` 通过，没有 `any`。

另外，`starter/` 原样跑一次会打印四行「练习未完成」——token 恒为 0、历史压不短、
重启读到 0 条、分叉污染父会话。四行全部消失，才算四个练习都做完了。

## 常见坑

- **切口落在工具调用中间**：`assistant` 的 `tool_calls` 和它的 `tool` 结果必须成对。
  切在两者之间，下一次请求就有了"有调用没结果"的悬空消息，多数厂商的 API 直接返回 400。
  用 `alignToTurnStart` 把切点往前挪到一轮的开头。
- **把系统提示词一起存进历史**：它里面有"现在时间"这种动态上下文，三天后读出来模型的
  日期判断全错。正确做法是每次恢复时用当前时间现拼，只有对话部分才落盘。
- **分叉时共享父会话的数组**：`child.messages = parent.messages` 看着能跑，
  但往子会话追加一条，父会话也跟着长——分叉的前提是父会话只读，必须截断 + `structuredClone`。
- **压缩直接覆盖原始历史**：摘要是有损且不可逆的，覆盖之后既没法回溯原话，也没法从被压掉的
  位置分叉。这里的做法是原始 JSONL 只追加，压缩只推高 `compressedUpTo` 并改写 `digest`。
- **忘了一起恢复压缩水位**：只恢复消息不恢复 `compressedUpTo`，阈值判断会把早已摘要过的那段
  又数一遍，于是要么反复压缩、要么迟迟不压。
