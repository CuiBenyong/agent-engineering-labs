# D25 实验：mini-koda 的 React 聊天前端

> 目标：给 mini-koda 写一个真能打开看的 React 聊天前端——逐字流式渲染、工具调用可视化成卡片、打断和重试。**值得做的地方在于打断那一步**：前端 `abort` 只让自己不听了，后端还在烧钱；这个实验里有一组对照自检，会把「两步打断」和「只 abort」的差别直接量给你看（5/70 对 70/70）。

## 你会学到

- 写一个 React 聊天页面骨架：输入框、消息列表
- 封装一个 SSE hook，订阅后端流式输出并逐字追加到消息里
- 在消息里插入工具调用的可视化卡片（工具名、参数、结果）
- 实现打断按钮，中途终止当前流式请求
- 实现失败重试，重试时带上幂等键避免重复副作用

## 目录

- `starter/`：挖了 5 个练习点的起始代码
- `solution/`：完整实现

```text
src/
├── server.ts        Fastify 后端：SSE 推流、/runs/:id/cancel、幂等键去重（端口 3025）
├── index.ts         SELFTEST 编排入口
├── stream/          **不依赖 React 的纯逻辑，七项自检测的就是这一层**
│   ├── parse.ts     SSE 跨块缓冲解析（练习 1）
│   ├── reduce.ts    事件归并成回合与工具卡片（练习 2）
│   └── client.ts    startRun / stopRun / 幂等键 / 节流 flush（练习 3、4、5）
└── web/             React 界面：App.tsx、main.tsx、store.ts（Vite dev server 4025）
```

分层是刻意的：**流式逻辑全在 `stream/` 里，是普通的纯函数，可以脱离浏览器直接测**；
`web/` 只负责订阅和渲染。浏览器界面没法自测，所以自检打的是 `stream/` 那一层。

## 怎么跑

```bash
cd starter                       # 或 solution
pnpm install --ignore-workspace  # 打印 ERR_PNPM_IGNORED_BUILDS 并非 0 退出是正常的
MOCK=1 SELFTEST=1 pnpm start     # 七项自检，跑完退出
```

`MOCK=1` 下**不需要真模型、不需要 API key**：后端吐的是一段固定脚本的 SSE，
里面包含一次完整的工具调用事件序列（`tool:proposed` → `tool:start` → `tool:end`），
前端才有卡片可渲染。

想打开浏览器看真实效果：

```bash
MOCK=1 pnpm dev   # 后端 3025，前端 4025，打开 http://127.0.0.1:4025
```

**端口是 3025 / 4025，不是 Vite 默认的 5173**——机器上可能还有别的前端项目在跑。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。装完检查一下有没有多出
> `pnpm-workspace.yaml`，有就删掉。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 七项自检全部 ✅、退出码 0（`starter/` 原样跑是 2/7）。
2. 第 1 项证明解析器有跨块缓冲：把报文切碎了喂进去仍能解出 4 个事件、拼回完整文本（`starter/` 解出 0 个）。
3. 第 2 项证明工具事件按 `callId` 归并：三条 `tool:*` 事件合成 1 张卡片、状态 `done`（`starter/` 是 3 张卡、状态停在 `proposed`）。
4. 第 4、5 项是一组对照，跑的是同一段流：两步打断的那组后端停在 **5/70**，只 abort 的那组后端照跑到 **70/70**。
5. 第 6 项证明重试复用同一个 `idempotencyKey`：拿回的是同一个 run（`resumed=true`）；第 7 项证明节流生效：200 个 token 只提交 **8** 次渲染（`starter/` 是 200 次）。

## 常见坑

1. **本机直连时不写跨块缓冲也「能跑」。** 局域网下一帧几乎不会被切开，解析器少了缓冲照样看起来正常，只有弱网或大响应才露馅。第 1 项自检故意把报文切碎了喂进去，就是为了让这个 bug 在本地现形。
2. **只 `abort` 不发 cancel。** 界面立刻安静了，很有欺骗性——但后端那个 run 还在跑、还在写库、还在计费。第 4、5 项那组对照就是专门为这件事设计的，跑一遍就明白差别有多大。
3. **重试时重新生成幂等键。** 后端认不出这是同一句话，会真的再跑一个 run：两倍的 token 钱，还可能有两次不可逆的工具调用。判据是「要发送的内容变没变」——同一句话重试用同一个键，用户改了内容重发才换新键。
4. **节流之后忘了在流结束和打断时强制 flush。** 最后不足 30 毫秒的那一小段会永远留在缓冲里，用户看到的回复少半句，而且这个 bug 只在回复长度不是批次整数倍时出现。
