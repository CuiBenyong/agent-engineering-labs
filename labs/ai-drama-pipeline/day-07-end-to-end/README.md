# D7 实验：一条命令从一句话产出一集成片的端到端脚本与一份运行账单

> 目标：把前六天各自跑通的六个环节首尾相接，用一条命令从一句话产出一集成片，
> 并且量出每个环节花了多少时间、多少钱。这一天故意不修任何失败——
> 你要亲眼看到「第四步炸了，前三步的钱白花」这件事，D8 才有意义。

## 你会学到

- 把六天的环节串成一条命令，统一产物目录与命名规则
- 给每个环节加上计时与花费记录，运行结束后打印一张账单
- 人为让第四个环节失败，观察现在的表现，并把痛点写进报告
- 完整跑通一集并观看成片，按检查清单逐项记录质量问题
- 写下三个脆弱点与对应的改造方向

## 目录

- `starter/`：挖了 4 个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `src/providers/`、`src/ffmpeg.ts`、`src/run.ts`、`src/dag.ts` **来自 D1，本天不改**
- `src/episode.ts`、`src/timeline.ts`、`src/compose.ts` **来自 D6，本天不改**
- 本天新增的只有三个文件：
  - `src/stages.ts`：六个环节的定义与依赖
  - `src/billing.ts`：按环节摊开的账单
  - `src/index.ts`：串联、失败处理与痛点报告

## 怎么跑

需要本机装好 ffmpeg（含 `ffprobe`）：

```bash
brew install ffmpeg                      # macOS
sudo apt-get install -y ffmpeg           # Debian / Ubuntu
```

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 MINIMAX_API_KEY；没有 key 就一直用 MOCK=1
MOCK=1 pnpm start                                  # 跑完六个环节并打印账单
MOCK=1 pnpm start "废柴保安捡到一把能开任何门的钥匙"   # 换一句话，六个环节的输入跟着变
INJECT=failnode4 MOCK=1 pnpm start                 # 让第四个环节失败，看痛点报告
WORK_DIR=~/drama-out pnpm start                                         # 真实厂商（会花钱）（产物写仓库外：花过钱的素材别放临时目录）
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 pnpm start` 一条命令跑完 `script → assets → first-frame → clip → voice → compose` 六个环节，`work/runs/<runId>/output/` 下出现成片、字幕与封面。
2. 账单按环节列出耗时、耗时占比、调用次数、产物数与折算花费，并指出最慢和最贵分别是哪一环。
3. 换一句话再跑，六个环节的输入都跟着变（梗概字数、提示词、产物内容都不同），说明业务逻辑是真的在跑，不是在放录像。
4. `INJECT=failnode4 MOCK=1 pnpm start` 之后：进程以非 0 退出，账单里 `clip` 那一行有花费但产物为 0，痛点报告打印出「已经花掉 ¥3.1250，现在唯一的办法是从头再跑一遍」。
5. 终端最后打印了看片检查清单与三个脆弱点，每个脆弱点都点名了第二周由哪一天解决。

## 常见坑

- **产物路径是串联之后第一个咬人的问题。** 单独调试时随手写 `output/episode-1.mp4` 完全没问题，串起来跑第二遍就把第一遍的成片覆盖了，出了事故也分不清哪个文件属于哪次运行。所有产物都要挂在 `runId` 下面。
- **失败的那一环也花了钱。** 视频环节是逐镜调用的，第三镜炸掉时前两镜的钱已经付了。如果账单只统计「成功的环节」，复盘时这笔钱就凭空消失了——本实验特意把失败节点也记进账单。
- **离线模式下的耗时排名是假的。** 视频接口被打了桩，本地 ffmpeg 反而成了大头。真实模式下 `clip` 一镜要排队好几分钟，耗时那一列会完全改写。但「最贵的是 clip」这个结论离线和真实是一致的。
- **不要在这一天顺手加重试。** 加了之后你就看不清「没有断点续跑有多痛」，D8 的动机也就没了。这一天的失败处理就是：记账、报告、退出。
