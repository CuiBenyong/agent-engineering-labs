# D1 实验：给自己的项目写一份 AGENTS.md

> 目标：给你自己的项目写一份 Codex 一眼能读完的 AGENTS.md，并亲眼验证三件事——它真的被读到了、子目录规则真的会覆盖根规则、审批与沙箱真的在按你选的组合工作。今天的产出是文档，不是程序。

## 你会学到

- 在自己的项目根目录跑一次 codex，看它在没有 AGENTS.md 时怎么摸索项目
- 照模板写一份 AGENTS.md：怎么装、怎么测、哪些目录不能碰、提交信息格式
- 把一段规则挪到子目录的 AGENTS.md 里，验证子目录规则覆盖根规则
- 分别用 read-only 与 workspace-write 跑同一个任务，记录哪一步弹了审批
- 把 AGENTS.md 精简到 Codex 一眼能读完的长度，删掉所有它能自己发现的信息

## 目录

这是**文档型实验**：没有代码、不需要 `pnpm install`、不需要 `MOCK=1`。

- `starter/AGENTS.md`：挖了空位的模板，待填处是 `> TODO：` 引用块
- `starter/legacy/AGENTS.md`：子目录覆盖规则的模板
- `solution/AGENTS.md`：给本课 TODO API 示例项目写好的一份
- `solution/legacy/AGENTS.md`：子目录覆盖的示范

## 怎么用

1. 先装好 Codex CLI（`npm install -g @openai/codex` 或 `brew install --cask codex`），在自己的项目根目录跑一次 `codex`，**先不放 AGENTS.md**，让它「用中文解释这个项目怎么启动和测试」。它猜错或找不到的地方记下来——这些就是手册该写的内容。
2. 把 `starter/AGENTS.md` 复制到你的项目根目录，逐条把 `> TODO：` 换成你自己的内容。`solution/AGENTS.md` 是参照物，不是答案——它写的是本课的 TODO API，不是你的项目。
3. 挑一条规则（比如「校验用 zod」），在某个子目录放一份 `AGENTS.md` 写成相反的内容，`cd` 进去再跑同一个任务，确认它遵守的是子目录那条。
4. 分别用 `codex -s read-only` 和默认权限跑「给 POST /todos 补输入校验」，记录每一次审批弹在哪一步、你批了什么。
5. 最后做减法：凡是它打开 `package.json` 或源码就能发现的信息，全部删掉。

## 验收标准

1. 项目根目录有一份 AGENTS.md，Codex 在会话开头读到了它（改动方式与你规定的库一致）。
2. 某个子目录里放了一条与根目录相反的规则，在该子目录下工作时 Codex 遵守的是子目录那条。
3. 同一个任务分别用 `read-only` 与 `workspace-write` 跑过，你能说出各自在哪一步弹了审批。
4. AGENTS.md 里没有任何 Codex 自己打开文件就能发现的信息，总长度不超过一屏。

## 常见坑

1. **把项目介绍写进去。** 「这是一个用 Express 写的 TODO 应用」这类信息 Codex 打开 `package.json` 就知道，写了只是占用 32 KiB 的上限。只写约定、禁区、环境事实。
2. **指望 AGENTS.md 当门禁。** 它是提示词的一部分，长对话里模型可能忘掉某条。「绝对不能做」的事交给 `sandbox_mode` 与 `approval_policy`。
3. **子目录规则没生效。** 拼接是「从根到当前目录」，所以你得 `cd` 进子目录再起 codex；在根目录起、只是提到子目录的文件，子目录的 AGENTS.md 不会被读。
4. **没有 git 的目录默认权限不一样。** Codex 用 git 判断目录是否受版本控制，先 `git init` 再试，否则观察到的默认行为跟正文对不上。
