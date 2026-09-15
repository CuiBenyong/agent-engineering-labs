# D3 实验：用 Pi 重写 D2 的 Agent

> 目标：把 D2 那个手写的 Agent 循环换成会话式内核 —— 你只负责「注册工具、开会话、订阅事件、发一句话」四步，循环、分派、参数校验、结果回填全交给内核；做完之后打开内核源码，逐格核对昨天你写的哪一行现在住在哪个函数里。

## 你会学到

- 安装并初始化一个最小的 Pi SDK 项目
- 把 D2 的两个工具改写成 Pi SDK 的工具定义格式
- 用 Pi SDK 跑一次完整的多轮工具调用对话
- 对照阅读 dg-ai-notes 的三层架构与 Agent Loop 章节，标出和自己代码的对应关系

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案

两边各有一个 `src/pi-lite.ts`，它们完全相同，也**不是练习的一部分** —— 那是要读的那本书。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 OPENROUTER_API_KEY；没有 key 先用 MOCK=1
MOCK=1 pnpm start     # 离线模拟，走完整的两轮工具调用
MOCK=1 pnpm start --tool-error   # 让模型给工具填一个非法参数，看错误怎么回传
pnpm start            # 真模型
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

`MOCK=1` 下不需要任何 key：`pi-lite.ts` 里只有 `callModel` 一个函数碰网络，桩也只打在那一处。
循环、参数校验、工具分派、结果回填这些业务逻辑在离线状态下**照样真实执行**，所以你看到的现象是对的。

离线的假模型还会做两件有教学意义的事：

1. **它会看工具注册了没有。** 少注册一个工具，它会在回答里直说「我手上没有计算工具，那道算术没法算」。
2. **它会看工具描述写没写清楚。** 描述太含糊时，它会说「有个 calc 工具，但描述太含糊，判断不出该不该用它」。
   这是关键词长度判断，只是个演示级近似 —— 真实模型靠的是语义理解，别把这段代码当生产做法。

### 换成真 Pi SDK

`pi-lite.ts` 是按 Pi 公开接口的形状复刻的最小内核（四百行出头，近四分之一是注释，可以完整读完），
这样安排是为了让实验完全离线也能跑通、并且内核可以打开来读。想接真 SDK：

```bash
pnpm add @earendil-works/pi-coding-agent --ignore-workspace
```

然后把 `src/index.ts` 顶部的 import 换掉：

```ts
// import { createAgentSession, defineTool, ModelRuntime, SessionManager } from './pi-lite.js'
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
```

真 SDK 的 `defineTool` 用 typebox 描述参数（`Type.Object({...})`）而不是本实验的简化 schema，
`execute` 的返回值也是同样的 `content` 数组形状；模型来自 `~/.pi/agent/` 下的配置，
需要先配好 key 才能跑，这也是本实验默认不用它的原因。

## 验收标准

1. `MOCK=1 pnpm start` 能看到完整的一次多轮工具调用：先打印两条工具调用日志，再打印最终回答。
2. 两个工具都被调用到，且 `execute` 拿到的是内核按 schema 校验后的结构化参数，不是你自己 `JSON.parse` 出来的。
3. `MOCK=1 pnpm start --tool-error` 时日志里打的是 `[工具报错]` 而不是 `[工具返回]`，
   并且模型在下一轮改口说「不硬猜结果」，程序**没有崩溃**。
4. 事件日志里能按顺序看到轮次的开始与结束，最后一行打出 `stopReason=stop，一共跑了 2 轮`。
5. `pnpm typecheck` 通过，没有 `any`。

## 常见坑

- **在 `execute` 里把异常吞掉**：`starter/` 里那段 `try/catch` 返回「计算失败」就是反面教材 ——
  它是一条**正常**的工具结果，模型会以为工具跑成功了。工具失败就该抛，让内核转成带错误标记的结果回给模型。
- **把 `label` 当成 `description` 写**：`label` 只给界面看，模型看不到；模型判断要不要调工具，
  只读 `description` 和参数的字段描述。描述写含糊，模型就该调的时候不调。
- **在 `message_update` 回调里做重活**：这个事件逐 token 触发，频率极高。
  在里面写库、发请求、跑正则会把整条流式链路拖慢，正确做法是攒一批再处理。
- **以为用了框架就没有循环了**：循环还在，停止原因也还在，只是从你的 `if` 挪进了内核的 `if`。
  打开 `pi-lite.ts` 搜 `stopReason !== 'toolUse'`，那一行就是 D2 你亲手写的那一行。
