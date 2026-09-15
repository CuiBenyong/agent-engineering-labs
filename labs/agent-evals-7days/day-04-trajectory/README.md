# D4 实验：轨迹评分器与模拟用户

D1 的结果态评分器能回答「事情办成了没有」。今天补上它答不了的那一半：
**过程本身有没有问题**——该查的没查、不该碰的碰了、原地转了四圈、花了十倍的钱。

跑完这一天，你手里会多出一张这样的表：

```text
—— 失败归因（67/100 次试次失败）——
  loop                    29 次  43.3%
  forbidden-tool          20 次  29.9%
  missing-prerequisite    14 次  20.9%
  outcome-mismatch         4 次   6.0%
```

一个「成功率 33%」指导不了任何行动，这张表可以：占比最高的那一桶就是下一步要修的东西。

## 你会拿到什么

| 文件                          | 说明                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `src/core/types.ts`           | 五个核心名词（**冻结文件，与 D1 逐字相同**）            |
| `src/core/runner.ts`          | 试次执行器与两个概率指标（**冻结文件**）                |
| `src/agent/target.ts`         | 靶子 Agent（**冻结文件**）。今天要抓它的缺陷 2 与缺陷 3 |
| `src/agent/mock.ts`           | 可复现的随机源（**冻结文件**）                          |
| `src/graders/trajectory.ts`   | 轨迹评分器（**有三处 TODO**）                           |
| `src/agent/simulated-user.ts` | 模拟用户（**有一处 TODO**）                             |
| `src/tasks/day04.ts`          | 五条任务 + 一张按任务写的策略表                         |
| `scripts/selftest.ts`         | 八条不变量自检，**它就是今天的验收标准**                |

## 跑起来

```bash
cd starter
pnpm install --ignore-workspace
MOCK=1 pnpm selftest        # 现在应该红 7 项，这是正常的
```

> `pnpm install --ignore-workspace` 可能以非 0 退出并打印 `[ERR_PNPM_IGNORED_BUILDS]`，
> 这**不代表安装失败**。看 `node_modules` 有没有生成、`pnpm typecheck` 过不过，那两个是准的。

## 今天的练习

1. **`checkSequence`**（`graders/trajectory.ts`）——判必要前置与禁用工具。
   注意它判的是**偏序**：`check_policy` 只要在第一次 `issue_refund` 之前出现过就行，
   中间夹了别的调用、查了三次政策，都不算违规。
2. **`detectLoop`**（同上）——按「工具名 + 参数」的签名统计重复次数。
   **只按工具名统计是错的**：那会把「查十个不同订单」误判成死循环。
3. **`attributeFailures`**（同上）——把失败试次分桶，算占比，按次数排序。
   `share` 的分母是**失败数**不是总数。
4. **`runMultiTurn`**（`agent/simulated-user.ts`）——把单轮跑成多轮。
   world 在轮次之间是**共享**的，隔离的边界是试次不是轮次。

做完之后：

```bash
MOCK=1 pnpm selftest        # 八项全绿才算过
MOCK=1 pnpm start           # 看五条任务的真实数字与归因表
```

## 阈值为什么按任务定

`src/tasks/day04.ts` 的策略表里，`maxRepeats` / `maxSteps` / `maxCostCents` 都是**按 taskId** 写的，
只有兜底值放在 `'*'` 里。这不是过度设计：

- 一次查询就有结果的任务，同签名重复 3 次一定是循环；
- 而轮询一个异步任务的状态，本来就要查十几次。

定一个全局阈值，你只能在「漏掉一半死循环」和「误伤一半正常任务」之间挑一个。
**写不出理由的阈值就是拍脑袋**，它迟早会误伤一个正常任务，然后被人整条删掉。

## 手动验收清单

自检全绿**不等于**做完了。下面几条要你亲眼看一遍：

- [ ] `MOCK=1 pnpm start` 的输出里，`ev-101-refund-in-window` 这一行是
      「通过 13/20，失败分布：sequence 7」。**它的结果态 20 次全对**——
      20 笔退款一笔不多一笔不少，金额全对，而它有 7 次根本没查政策就退了。
      这就是只看结果态会漏掉的那一整类故障。
- [ ] 看 `ev-105-info-only-query`：outcome 20/20 通过，sequence 20/20 失败。
      用户只是来查有没有退过款，Agent 却开了一张人工工单。
      **结果态评分器在结构上看不见这件事**，因为「什么都没变」既是正确结果、
      也是乱开工单之后的结果。
- [ ] 把 `src/tasks/day04.ts` 里 `'*'` 的 `maxRepeats` 从 2 改成 10，重跑 `pnpm start`。
      `ev-102-nagging-user` 的 loop 失败会从 20 掉到 0——阈值决定你看不看得见这个缺陷。
      看完改回来。
- [ ] 把 `ev-103-expired-multi-turn` 的用户策略从 `persistentUser` 换成 `oneShotUser`
      （改 `day04Users`），重跑。这条任务的 loop 失败会消失，平均步数从 8.7 掉到 2 上下。
      **那条死循环只在多轮里才走得到**，单轮评估结构上碰不到它。看完改回来。
- [ ] 跑 `MOCK=1 pnpm start -- --seed 42` 两次，输出逐字相同；换 `--seed 7` 输出不同。
- [ ] 打开 `scripts/selftest.ts` 的第 3 条和第 5 条，读一遍注释里说的「为什么只断一边是恒真的」。

## 收工

```bash
# 跑过 lab 一定要清产物，否则仓库测试会超时或撞 ENOENT
find . -type d -name work -exec rm -rf {} + 2>/dev/null || true
```

代码 MIT。
