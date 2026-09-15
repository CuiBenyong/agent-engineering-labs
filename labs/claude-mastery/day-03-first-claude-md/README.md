# D3 实验：给自己的项目写的第一份 CLAUDE.md

> 目标：给**你自己正在写的项目**写一份不超过 60 行的 CLAUDE.md——命令、风格、规矩、完成的判据四段齐全，每一行都经得起「删掉会不会让 Claude 犯错」的追问。今天的产出是文档，不是程序。

## 你会学到

- 在自己的项目里跑 /init，看生成的 CLAUDE.md 里有什么
- 按「删到不能再删」的判据逐行删，留下 Claude 猜不到的东西
- 补上构建、测试、代码风格三段命令与规则
- 写一条「完成的判据」：哪条命令通过才算做完
- 用 /context 确认文件被加载，再用示例任务验证 Claude 的行为真的变了

## 目录

- `starter/CLAUDE.md`：四段骨架，待填处是 `> TODO：` 引用块，每段附提示问句
- `starter/prune-checklist.md`：逐行自检表，对 /init 生成的初稿标「留 / 删 / 改」
- `solution/CLAUDE.md`：给本课示例项目（Express TODO API，即 D4 实验目录的 `solution/`）写好的示范，39 行
- `solution/prune-log.md`：从 /init 初稿删到示范版的对照记录——删了什么、为什么

## 怎么用

这是**文档型实验**：不需要 `pnpm install`、不需要 `MOCK=1`、没有自检脚本。需要装好 Claude Code（`curl -fsSL https://claude.ai/install.sh | bash`）。

1. 进你的项目目录跑 `claude`，先问三个「新同事会问的问题」（测试怎么跑？日志怎么打？加接口改哪几个文件？）。
2. 跑 `/init` 生成初稿。**不要直接用**——它会写很多 Claude 自己读代码就能推出来的东西。
3. 打开 `starter/prune-checklist.md`，对初稿逐行标「留 / 删 / 改」。
4. 按 `starter/CLAUDE.md` 的四段结构重写，超过 60 行继续删。
5. 跑 `/context`，确认 Memory files 里有它；切到 Plan Mode（Shift+Tab）用示例任务让 Claude 出计划，检查规矩是否被遵守。

没有合适的项目时，用 D4 实验目录的 `solution/`（一个演示用的 TODO API）练手，然后对照 `solution/CLAUDE.md`。

## 验收标准

1. `CLAUDE.md` 不超过 60 行，四段齐全：命令、风格、规矩、完成的判据。
2. 逐行自检「删掉会不会让 Claude 犯错」，每一行都能说出「会犯什么错」；说不出的已经删掉。
3. 全文没有「写干净的代码」「遵循最佳实践」这类模型本来就会做的话，也没有 package.json 里能直接看到的脚本说明。
4. 在项目里跑 `/context`，Memory files 列表里能看到这份 CLAUDE.md。
5. 用示例任务在 Plan Mode 下跑一遍，Claude 的计划里体现了 CLAUDE.md 写的至少两条规矩。

## 常见坑

1. **把 /init 的初稿当成品。** 初稿常见的废话：目录结构逐个说明、依赖列表、「本项目使用 TypeScript」。这些 Claude 读一眼代码就知道，留着只是稀释真正的规则。
2. **写能力清单而不是禁止项。** 「可以使用 zod 做校验」没有信息量；「校验只用 zod，不引入其他校验库」才拦得住它顺手装 joi。
3. **规则含糊。** 「注意测试性能」Claude 不知道怎么执行；「只跑单文件测试 `pnpm vitest run <file>`，不要跑全量」它才会照做。
4. **写了流程。** 「部署步骤：1……2……3……」是 skill 的活，放 CLAUDE.md 每次会话都白吃窗口。D4 会讲怎么挪。
5. **没有「完成的判据」。** 缺这一段，Claude 的停止信号只剩「看起来做完了」。写清哪条命令通过才算做完。
