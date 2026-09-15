# D5 实验：双工具对比脚本与对比报告模板

> 目标：用同一个任务分别跑一遍 Codex 与 Claude Code，把两份运行记录填进同一个 JSON 模板，用脚本生成对比表，再在报告模板里逐行回答「这个差异来自工作方式还是能力」。脚本不调任何模型——它做的是把数据归一，比较是你自己做的。

## 你会学到

- 准备同一个 TODO API 起点，两边各建一份干净的工作副本
- 用 Codex 跑一遍任务，按模板记录交代、审批次数、验证方式、耗时与 token
- 用 Claude Code 跑同一任务，用同一模板记录
- 运行对比脚本，读两份运行记录生成对比表
- 把对比表贴进报告模板，写下你的选型结论和一条混用工作流

## 目录

- `runs/template.json`：运行记录模板，两边各抄一份填
- `runs/codex.json`、`runs/claude-code.json`：一次演练的示范记录（示范值，不是基准，你要用自己的覆盖）
- `report-template.md`：对比报告模板
- `starter/`：挖了 4 个练习的对比脚本，`MOCK=1` 下能跑（但表缺成本维度、不做可比性检查、不做归因）
- `solution/`：参考答案

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
MOCK=1 pnpm start                                        # 用内置样例记录看表长什么样
pnpm start ../runs/codex.json ../runs/claude-code.json   # 用你自己填的记录
```

这个实验**不需要 API key**，`.env.example` 是空的。`MOCK=1` 的作用只是用内置样例代替文件，所有解析、检查、渲染逻辑都真实执行。

> `starter/` 与 `solution/` 都不属于仓库根 pnpm workspace，`pnpm install` 时要加 `--ignore-workspace`。
> 安装时打印 `ERR_PNPM_IGNORED_BUILDS` 不是失败，看 `pnpm typecheck` 是否通过。

## 怎么做整个实验

1. 把 D1 的 TODO API 提交一次，记下 commit 短 id；`git worktree add ../todo-codex` 与 `git worktree add ../todo-claude` 各建一份工作副本。
2. Codex 副本放 AGENTS.md，Claude Code 副本放**同内容**的 CLAUDE.md；需求文字两边一字不改。需求与说明文件的字数记进 `promptChars` / `instructionsChars`。
3. 两边都用默认权限跑任务，记下每次审批的原因、是否主动跑测试、测试红了是否自己修、墙钟分钟数、会话结束时报告的 token；跑完各自 `/review`（Codex）与 `/code-review`（Claude Code），记意见数与你采纳的数量。
4. 填出 `runs/codex.json` 与 `runs/claude-code.json`，跑脚本，把表贴进 `report-template.md`，逐行归因。

## 验收标准

1. 两份运行记录 `runs/codex.json` 与 `runs/claude-code.json` 都按模板填完，起点 commit、需求文字、说明文件字数三项在两份里一致。
2. `pnpm start runs/codex.json runs/claude-code.json` 输出一张 Markdown 对比表，四个维度全部有数据。
3. `MOCK=1 pnpm start` 用内置样例数据也能输出同样形状的表。
4. 报告模板里每一行差异都填了「来自工作方式还是能力」，并写下了一条你自己的混用工作流。

## 常见坑

1. **两边的需求或说明文件不一样。** 哪怕只差一句「改完跑测试」，验证行为的差异就说不清来源。脚本的可比性检查会拦住 commit 与字数不一致，但拦不住内容不同——这一条靠你自觉。
2. **把示范记录当基准。** `runs/` 里的两份 JSON 是一次演练的数字，只用来演示脚本，不代表两家工具的真实水平。
3. **一次运行就下结论。** coding agent 输出有随机性，写进团队文档的数字至少跑三次取中位数。
4. **审批次数直接当成「安全性」。** 次数差异多半来自默认权限模型不同（沙箱内不问 vs 按工具类型逐次问），是工作方式而不是能力，配置就能弥补。
