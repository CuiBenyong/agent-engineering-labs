# D4 实验：「提交前自动 lint 加测试」的 hooks 配置 + 一个 skill

> 目标：在一个几十行的演示项目（Express + zod + vitest 的 TODO API）上装两条门禁——写 `migrations/` 一律拦下、测试不过不许结束这一轮——再写一个把「加校验 + 补测试」固化成五步流程的 skill。附一个不需要 Claude Code 的事件模拟器，让你写 hook 脚本时能秒级迭代。

## 你会学到

- 在演示项目里配置一条 PreToolUse hook，拦住对 migrations 目录的写入
- 配置一条 Stop hook，测试没过就不允许结束这一轮
- 写一个 SKILL.md：给 TODO API 补校验与测试的固定流程
- 用本地的事件模拟器跑一遍 hooks，观察退出码与阻止原因
- 在 Claude Code 里用 /hooks 与 /skill-name 各触发一次，确认真的生效

## 目录

`starter/` 与 `solution/` **各自就是一个完整的演示项目**（可以直接用 Claude Code 打开）：

```
solution/
├── CLAUDE.md                         # D3 实验写好的入职手册（同一份）
├── .claude/
│   ├── settings.json                 # 两条 hook 的配置：PreToolUse(Edit|Write) 与 Stop
│   ├── hooks/guard-migrations.mjs    # PreToolUse：路径命中 migrations/ 就 exit 2
│   ├── hooks/require-green.sh        # Stop：跑单文件测试，失败 exit 2 并把摘要写到 stderr
│   └── skills/add-validation/SKILL.md  # /add-validation <路由> 的五步流程
├── src/app.ts  src/store.ts  src/routes/todos.ts   # 演示 API（已带 zod 校验）
├── test/todos.test.ts                # 5 个用例，用 node fetch 打真实端口
├── migrations/0001_init.sql          # hook 的靶子，不要手改
└── src/index.ts                      # 事件模拟器（pnpm start）
```

`starter/` 结构完全相同，但两个 hook 脚本是空壳（一律放行）、SKILL.md 的 description 与五步是 TODO——共 3 个练习点。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
pnpm test             # 演示项目的 5 个测试（Stop hook 跑的就是它）
pnpm start            # 事件模拟器：把 3 个假事件喂给 hook，打印退出码与理由
```

模拟器不联网，所以 `MOCK=1` 在这里没有意义（接受但忽略）。真正的验证要用 Claude Code：

```bash
cd solution
claude                         # 第一次进入会有信任确认——注意 hook 是会在你机器上跑的代码
/hooks                         # 看到两条 hook
把 migrations/0001_init.sql 里的表名改成 tasks     # 应被拦下并说出理由
/add-validation POST /todos    # Claude 按 SKILL.md 的五步执行，最后贴测试输出
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace，`pnpm install` 时要加 `--ignore-workspace`（各自目录下的 `.npmrc` 已经写了）。`pnpm install` 可能因为依赖构建脚本被拦截而以非 0 退出，看 `node_modules` 是否生成、`pnpm typecheck` 是否通过。

## 验收标准

1. `pnpm start` 跑事件模拟器，对「写入 migrations/ 下文件」的 PreToolUse 事件打印退出码 2 与拒绝理由；对「写入 src/ 下文件」打印退出码 0。
2. 模拟器对 Stop 事件，在演示项目测试失败时打印退出码 2 与失败摘要，测试通过时打印退出码 0（故意把 `test/todos.test.ts` 里一个断言改坏再跑一次验证，然后改回来）。
3. `.claude/skills/add-validation/SKILL.md` 有 name、description、argument-hint 三个字段，正文是五步以内的流程，用到了 $ARGUMENTS。
4. 在真实的 Claude Code 里打开项目，`/hooks` 能看到两条 hook；让它改一个 migrations/ 下的文件，会被拦下并说出理由。
5. 在真实的 Claude Code 里输入 `/add-validation POST /todos`，Claude 按 SKILL.md 的顺序执行，最后贴出测试输出。

## 常见坑

1. **退出码写成 1。** 只有 `exit 2` 是「阻止」；`exit 1` 会被当成「hook 脚本自己出错」，动作照样放行，你还以为拦住了。模拟器会把这种情况标成「脚本出错但不阻止」。
2. **理由写到 stdout。** 阻止的理由要写到 **stderr**，模型才收得到；stdout 在 exit 0 时会被当成结构化 JSON 决定来解析。
3. **Stop hook 里跑全量测试。** 全量会起真实服务器、慢且可能超 timeout；CLAUDE.md 的规矩是只跑单文件，hook 也照做。`timeout` 字段的单位是秒。
4. **hook 脚本没有可执行位。** `require-green.sh` 直接作为命令执行，需要 `chmod +x`；用 `node xxx.mjs` / `python xxx.py` 显式调用的脚本不需要。
5. **把「有时该做」的事写成 hook。** hook 是无条件的：一条「每次编辑后跑全量 lint」的 PostToolUse hook 会让每次改动都等十几秒。只把「一次例外都不能有」的事做成 hook，其余留在 CLAUDE.md。
6. **description 太泛。** 「处理 API 相关任务」会让 skill 在几乎所有任务上被误触发；「用户提到加校验、补测试时使用」才是好的触发词。
