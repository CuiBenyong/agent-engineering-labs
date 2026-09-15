# D5 实验：给每一次运行装上链路

前四天做的都是**离线**评估：你出题、你跑、你判分。
今天要做的是把同一套东西接到**线上**：一次运行落成一棵可查的链路树，
一批运行汇成一张按任务分组的成本与延迟面板，
而前四天的评估分数**本身**变成链路上的一个属性。

跑完这一天，你手里会有一个能回答这三个问题的工具：

> 这条链路里哪一步最慢？这个任务一个月烧了多少钱？线上失败的那批请求，长什么样？

## 你会拿到什么

| 文件                                      | 说明                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `src/core/types.ts` `src/core/runner.ts`  | evalkit 内核（**冻结文件，一个字都不要改**）                     |
| `src/agent/target.ts` `src/agent/mock.ts` | 靶子与随机源（**冻结文件**）                                     |
| `src/otel/semconv.ts`                     | 属性名常量表与**钉死的约定版本**（已给全，今天最该读的一个文件） |
| `src/otel/tracer.ts`                      | 最小链路记录器（**有一处 TODO**）                                |
| `src/otel/instrument.ts`                  | 埋点层：包在靶子外面（**有两处 TODO**）                          |
| `src/otel/aggregate.ts`                   | 成本 / 延迟 / 失败率聚合 + 尾部采样（**有一处 TODO**）           |
| `scripts/collector.ts`                    | 玩具收集端，HTTP 3145，只用 `node:http`                          |
| `scripts/selftest.ts`                     | 十条不变量自检，**它就是今天的验收标准**                         |

⚠️ **靶子和 runner 都是冻结文件，今天的埋点一行都不许改它们。**
这不是人为限制，而是真实处境的还原：线上那个 Agent 多半不是你写的，或者它已经在跑。
**能包就不要改**——今天的埋点全部做在包裹层里。

## 跑起来

```bash
cd starter
pnpm install --ignore-workspace
MOCK=1 pnpm selftest        # 现在应该红 6 项，这是正常的
```

> `pnpm install --ignore-workspace` 可能以非 0 退出并打印 `[ERR_PNPM_IGNORED_BUILDS]`，
> 这**不代表安装失败**。看 `node_modules` 有没有生成、以及 `pnpm typecheck` 过不过，那两个是准的。

## 今天的练习

四处 TODO，顺序做下来刚好是一条链路从无到有的过程：

1. **`tracer.ts` 的 `start()`** —— 把父子关系接上：有 parent 时继承它的 `traceId`，
   并把 `parentSpanId` 指过去。现在每条 span 各自成一棵孤树。
2. **`instrument.ts` 的 `emitModelTurn()`** —— 补全 chat span 的属性，
   并为每一次工具调用开一条 `execute_tool` span，**父亲是 chat 不是 root**。
   属性名一律从 `semconv.ts` 的 `GEN_AI` 常量里取，**不许手写字符串**。
3. **`instrument.ts` 的 `attachEvaluation()`** —— 把评估结论写成
   `gen_ai.evaluation.*` 四个属性挂回根 span，不通过时把 span 标成 `error`。
4. **`aggregate.ts` 的 `spanCostCents()`** —— 按 token 用量与单价算钱。
   **不要去抄 runner 的 `totalCostCents`**：这个面板存在的全部意义，
   就是它的每个数字都只从 span 里来。

做完之后：

```bash
MOCK=1 pnpm selftest        # 十项全绿才算过
MOCK=1 pnpm start           # 看面板
```

## 手动验收清单

自检全绿**不等于**做完了。下面几条要你亲眼看一遍：

- [ ] `MOCK=1 pnpm start` 的面板里，`ev-004-nagging-user` 那一行的**失败率和别人一样低，
      但工具调用次数是别人的两倍多**。想清楚：只看 pass 率永远发现不了这件事。
- [ ] 同一行的花费也明显更高。链路面板抓的是**正确性以外的代价**。
- [ ] `ev-002-expired-order` 的失败率不是 0。去 `work/traces.jsonl` 里 grep
      `"gen_ai.evaluation.score.label":"fail"`，看那条链路的 `explanation` 写了什么。
- [ ] 开两个终端，一个跑 `MOCK=1 pnpm start`，另一个跑 `pnpm collector`，然后：

  ```bash
  curl http://localhost:3145/                              # 列出全部 traceId
  curl 'http://localhost:3145/trace?id=<贴一个 traceId>'    # 看这条链路的树
  curl http://localhost:3145/panel                         # 面板的 JSON
  ```

  树必须是三层：`invoke_agent` → `chat` → `execute_tool`。**只有两层就是父子没接上。**

- [ ] 跑 `MOCK=1 pnpm start -- --sample 0.2`，对比 span 条数。
      失败的链路一条都不能少——去面板上数一下失败数，采样前后必须相同。
- [ ] 打开 `src/otel/semconv.ts`，把 `SEMCONV_VERSION` 那一段注释读完。
      这套约定**没有 1.0**，属性名还会改，而且主仓库页面上每一条都标着「已弃用」——
      那是搬家，不是废弃。想清楚为什么这个文件必须存在。
- [ ] 面板最后一行写着「首块延迟采集覆盖率：0/20　均值：未采集」。
      这是**故意**的：离线靶子不是流式的，这个数拿不到。
      想清楚为什么写「未采集」比写一个 0 好。

## 三层链路树长什么样

```text
· invoke_agent refund-agent (offline)  253ms
  · chat mock-model  252ms
    · execute_tool lookup_order  20ms
    · execute_tool check_policy  22ms
    · execute_tool issue_refund  61ms
```

工具 span 挂在 `chat` 下面而不是与它平级，是因为工具是**这一轮模型调用**决定要调的。
两种画法在真实埋点库里都见得到，**重点不是哪种对，而是全公司用同一种**——
不然按层级做的聚合查询在两个服务之间就对不上。

## 收工

```bash
# 跑过 lab 一定要清产物，否则仓库测试会超时或撞 ENOENT
find . -type d -name work -exec rm -rf {} + 2>/dev/null || true
lsof -ti:3145 | xargs kill 2>/dev/null || true
```

代码 MIT。
