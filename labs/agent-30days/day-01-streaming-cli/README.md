# D1 实验：流式 CLI 聊天程序

> 目标：不借助任何 SDK，用原生 `fetch` 调大模型 API，解析 SSE 流式输出，做出“打字机”效果的命令行聊天。

## 你会学到

- messages / roles 长什么样，历史为什么要自己维护
- `stream: true` 之后服务器返回的到底是什么（SSE 文本协议）
- 如何切换模型、如何看 token 用量

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 先用 MOCK=1
MOCK=1 pnpm start     # 离线模拟
pnpm start            # 真模型
MODEL=anthropic/claude-3.5-haiku pnpm start   # 换模型
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），如果 `pnpm install` 报 workspace 相关错误或想装到根 `node_modules`，加上
> `--ignore-workspace`（各自目录下的 `.npmrc` 已经写了 `ignore-workspace=true`，多数情况下不用手动加）。

## 验收标准

1. 输入一句话，回复是**逐字**打印出来的，不是等半天一次性出现。
2. 连续问两轮，第二轮模型记得第一轮说了什么（说明历史带上了）。
3. 换 `MODEL` 后能正常回复，并且能观察到不同模型的风格/速度差异。
4. 每轮结束打印 `[usage] prompt=… completion=…`。

## 常见坑

- 半行：网络分包不会按行切，最后一段要留到下一轮拼。
- 忘记 `Content-Type: application/json` 会得到 4xx。
- 把 `data: [DONE]` 也拿去 `JSON.parse` 会炸。
