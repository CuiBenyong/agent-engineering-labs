# D2 实验：一个打字机式增量输出的终端渲染层，能在流中断与用户打断时优雅收尾

> 目标：把 D1 那个「攒完再打」的黑屏换成真正的增量渲染——SSE 按空行分帧、分片翻译成语义事件、
> 渲染器逐片写屏，并且在流中途断开与用户按下 Ctrl+C 这两种收尾里都不丢已经收到的内容。
> 这一天做完，网关层（`gateway.ts`）与离线剧本引擎（`mock.ts`）就定稿了，后面十九天原样复制。

## 你会学到

- 手写 SSE 解析器，按空行切事件并处理多行 data 与结束标记
- 把分片翻译成语义事件，让渲染层完全看不到网关的报文格式
- 实现打字机渲染：逐段刷新、代码块延迟成型、行尾光标处理
- 用故障注入让流在中途断开，确认提示是人话而不是堆栈
- 自检里断言收到的分片数与最终文本，证明拼接没有丢字

## 目录

```text
src/
  index.ts            来自 D1，本天不改
  config.ts           来自 D1，本天不改
  seed.ts             ★ 冻结（D1 定稿），本天不改
  kernel/
    types.ts          ★ 冻结（D1 定稿），本天不改
    tools.ts          来自 D1，本天不改（今天还没有工具）
    loop.ts           来自 D1，本天加了两处：错误的可重试分类、每片之间的打断检查（TODO(3)）
  providers/
    types.ts          ★ 冻结（D1 定稿），本天不改
    index.ts          ★ 冻结（D1 定稿），本天不改
    gateway.ts        ★ 本天定稿并冻结：按空行分帧的 SSE 解析、工具分片、断流检测、429
    mock.ts           ★ 本天定稿并冻结：剧本引擎，支持工具分片与 INJECT 注入
  mock-script.ts      今天的剧本：一段长回答 + 一段带围栏代码块的回答
  render.ts           本天重写：MarkdownStream 增量渲染（TODO(1)、TODO(2)、TODO(4)）
  repl.ts             来自 D1，本天改了两处：渲染改成流式、接上 Ctrl+C 打断
  selftest.ts         本天重写：六项断言
```

★ 标记的文件是全课地基，后面每天原样复制，**一个字节都不要改**。
`gateway.ts` 与 `mock.ts` 从今天起成为权威副本，D1 里的是它们的最小前身。

- `starter/`：挖了四个练习点（`TODO(1)`–`TODO(4)`），typecheck 干净，自检 3/6
- `solution/`：参考答案，自检 6/6

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env

# 验收入口：全课二十一天统一用这一条
MOCK=1 SELFTEST=1 pnpm start

# 看打字机效果（在真终端里直接跑更明显，管道里退化成纯追加）
printf '解析器长什么样\n/exit\n' | MOCK=1 pnpm start

# 看断流：提示应该是一句人话，不是堆栈
printf '讲讲流式\n/exit\n' | MOCK=1 INJECT=truncated pnpm start

# 连真模型：任何 OpenAI 兼容网关都行
LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_API_KEY=sk-... LLM_MODEL=openai/gpt-4o-mini pnpm start
```

> `pnpm install --ignore-workspace` 可能以非 0 退出并打印 `Ignored build scripts: esbuild`，
> 这不代表安装失败——看 `node_modules` 有没有生成、`pnpm typecheck` 过不过就够了。

## 验收标准

- [ ] `MOCK=1 SELFTEST=1 pnpm start` 打印 `6/6 通过`
- [ ] 那段长回答被切成 34 个分片逐片渲染，去掉 ANSI 之后与分片拼接结果逐字一致
- [ ] 问「解析器长什么样」，围栏代码块完整成型，中间没有出现 `` 被当成行内代码的那一帧
- [ ] 打断之后事件是 `done/aborted`，已经收到的字符留在消息数组里，不是整轮丢弃
- [ ] `INJECT=truncated` 时终端出现「流在中途断开」并保留已收到的三个分片，没有堆栈

## 常见坑

- **SSE 的事件边界是空行，不是换行。** 一条事件可以有多行 `data:`，按规范要把它们用换行拼成一个载荷再解析。按行读在多数网关上「碰巧能跑」，遇到多行 data 就丢内容。
- **网络分块与事件边界毫无关系。** `res.body` 给你的是字节块，一条事件可能横跨两块、一块里也可能挤着五条事件。所以必须留 `buffer`，把没凑齐的尾巴留到下一块。
- **流可能没有结束事件就断掉。** 只靠 `for await` 正常结束来判断「说完了」，断流会被当成正常收尾，用户看到半句话却没有任何提示。要在循环外面判断「见过 finish 或 `[DONE]` 了吗」。
- **管道里没有光标。** `\r` 与清行转义在非 TTY 环境里是噪音，本实验按 `process.stdout.isTTY` 分了两条路径：真终端重画当前行，管道纯追加。所以验收判据是自检的断言，不是「颜色好不好看」。
- **未定型的行不要上样式。** 收到 `` 就按行内代码上色，等第三个反引号到达再改回围栏，屏幕会闪一下。判据写在 `looksUnsettled` 里：还可能变的行按原样显示。
