# D5 实验：一条跑在 CI 里的 claude -p 任务脚本

> 目标：把 `claude -p` 包成一条能进 CI 的命令——喂它一个 PR 的 diff，让它做安全审查，解析 `--output-format json` 的结果判断成败与花费，超预算或出错就非零退出，再由 GitHub Actions 把结果贴回 PR。三道锁（权限、预算、可复现）全在参数里。

## 你会学到

- 写一个脚本，用 child_process 调 claude -p 并传入 --output-format json
- 解析 result、is_error、num_turns、total_cost_usd，超预算或出错就非零退出
- 用 --allowedTools 收紧权限，用 --max-turns 设上限
- 写一份 GitHub Actions 工作流，在 PR 上跑这条任务并把结果贴回来
- MOCK=1 下返回固定的 JSON 结果，本地没有 claude 命令也能验证解析逻辑

## 目录

- `starter/`：挖了 3 个练习点（拼参数、判成败、补 MOCK 场景），`MOCK=1` 下可以直接跑
- `solution/`：参考答案；`solution/ci.py` 是同一件事的 Python 版（不走 pnpm，直接 `python ci.py`）
- 两边都有 `.github/workflows/claude-review.yml`：在 pull_request 上跑脚本并把 `result` 评论到 PR

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 真跑需要 ANTHROPIC_API_KEY（--bare 不读订阅登录）

MOCK=1 pnpm start                              # 离线，success 场景，exit 0
MOCK=1 MOCK_SCENARIO=over-budget pnpm start    # 超预算，exit 1
MOCK=1 MOCK_SCENARIO=max-turns pnpm start      # 轮数耗尽，exit 1
MOCK=1 MOCK_SCENARIO=error pnpm start          # 认证失败等错误，exit 1

pnpm start                                     # 真跑：git diff main 喂给 claude -p，结果写 review.json
BASE_REF=origin/main MAX_BUDGET_USD=0.2 pnpm start   # 覆盖默认值
```

一次性脚本，不需要管道喂输入；验收看**打印出的判定与退出码**（`echo $?`），不要只看有没有报错。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace，`pnpm install` 时要加 `--ignore-workspace`（各自目录下的 `.npmrc` 已经写了）。`pnpm install` 可能因为依赖构建脚本被拦截而以非 0 退出，看 `node_modules` 是否生成、`pnpm typecheck` 是否通过。

## 验收标准

1. `MOCK=1 pnpm start` 在没有 `claude` 命令的机器上也能跑通：打印一份固定的 JSON 结果解析——成败、轮数、成本、结果摘要——并以 0 退出。
2. `MOCK=1 MOCK_SCENARIO=over-budget pnpm start` 以非零退出，并打印「超预算」的原因；`MOCK_SCENARIO=error` 同理打印错误信息。
3. 装了 `claude` 且设了 `ANTHROPIC_API_KEY` 时，`pnpm start` 真的调用 `claude -p`，打印出的命令行里带 `--bare --output-format json --permission-mode --max-turns --max-budget-usd`，并把结果写到 `review.json`。
4. `.github/workflows/claude-review.yml` 在 pull_request 事件上跑这个脚本，把 `result` 作为评论贴回 PR，密钥从 secrets 读，权限只有 `pull-requests: write`。
5. 脚本被 `--max-turns` 或预算截断时，退出码非零且日志里能看出是哪一道锁触发的（`触发的锁：turns / budget / error`）。

## 常见坑

1. **忘了 --permission-mode。** `-p` 模式在所有计划上的起始档位都是 Manual，无人值守时遇到要问的动作会直接被拒——这本身没错，但你要显式选一档（CI 用 `dontAsk`），否则行为取决于默认值的变化。
2. **轮数耗尽被当成普通错误。** `error_max_turns` 时 `is_error` 也是 true；先判 subtype 再判 is_error，日志才能说清是「预算锁」触发而不是「出错了」。
3. **--bare 之后 Not logged in。** `--bare` 不读订阅登录和系统钥匙串，CI 必须设 `ANTHROPIC_API_KEY`（从 secrets 来，不要写进 workflow 文件）。
4. **没有 --bare 就在 CI 上跑陌生分支。** PR 分支里别人提交的 `.claude/settings.json` hooks 会在 runner 上执行，且 `-p` 没有信任对话框。`--bare` 同时是可复现措施和安全措施。
5. **把 diff 当位置参数传。** 大 diff 会撞命令行长度上限；走 stdin 管道，并用标签把它包起来（D1 的习惯），提示词本身放管道最前面。
6. **workflow 给了过宽权限。** 审查只需要 `pull-requests: write`；不要给 `contents: write`，否则一条被注入的提示词就能让它改代码。
