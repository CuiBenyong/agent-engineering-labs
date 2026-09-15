# D21 实验：把 mca 打成包、装到临时前缀、在一个陌生目录里跑通一次真实任务

> 目标：让**别人**也能用上这二十一天做出来的东西。今天不加任何新能力，只做四件
> 「不做就等于没做完」的事：可执行入口与打包产物、配置分层与来源追踪、版本与更新提示、
> 首次运行的人话引导。收尾是一条真跑的验证链：`npm pack` → 装到临时前缀 →
> 在一个和本仓库毫无关系的空目录里跑 `mca --version` 与一次真实任务。
>
> 现象最好看的两条：**装完之后 `mca --task "修一下失败的测试" --yes` 在临时目录里
> 真的改了文件、真的跑了测试**；以及 `mca --config` 把每个值来自哪一层逐行摊开——
> 同一个 `model`，四层各赢一次。

## 你会学到

- TypeScript 项目怎么进包：为什么是**编译成 JS 发 dist**，而不是把 `tsx` 拖成运行时依赖
- `tsc` 只搬它会编译的文件：**非 TS 资产要自己搬**，而且必须按目录遍历不能手写清单
- `files` 字段为什么必须**按目录枚举**——逐个文件列的清单会在某一天悄悄过期而不报错
- `bin` 入口的三件事：shebang、扩展名、以及为什么它一行业务都不该写
- 配置分层的优先级不是品味是推导：**作用范围越窄的越大**
- 为什么每个配置值都要记住**它从哪来**，以及 `--config` 为什么是必需功能不是调试功能
- 密钥为什么不许进配置文件，以及「拒绝并说出来」为什么好过「静默忽略」
- 更新检查的四条规矩：失败静默、有超时、有节流、离线模式不查
- 首次运行的一段人话要回答哪三个问题
- 非交互模式（`--task`）的审批默认答案为什么必须是**拒绝**
- 全局安装之后「包在哪」「项目在哪」「用户配置在哪」第一次分开，以及为什么本地永远复现不出这类 bug

## 目录

```text
bin/
  mca.mjs             本天新增：全局命令的入口（shebang + 一行 import）
scripts/
  build.mjs           本天新增：tsc 编译 + 把非 TS 资产按目录搬进 dist
  verify-pack.mjs     本天新增：打包 → 临时前缀安装 → 在陌生目录里跑两条命令 → 清干净
skills/               来自 D16，本天不改（现在它们是**随包分发**的那一批）
src/
  seed.ts             ★ 冻结（D1 定稿），本天不改
  providers/          ★ 冻结（D1 与 D2 定稿），本天不改
  kernel/ tools/ refs/ context/ plan/ snapshot/ session/ mcp/ skills/  来自 D20，本天不改
  agents/             来自 D17（子 Agent 派发），本天不改
  hooks/ tasks/       来自 D18（钩子与后台任务），本天不改
  vision/             来自 D19（图片输入），本天不改
  evals/              来自 D20（基准集、计量与端口 3120 的面板），本天不改
  tools/background.ts 来自 D18（run_background），本天不改
  repl-input.ts       来自 D18 的纯搬运（行队列与三种审批提示），本天不改
  mock-scenes.ts      来自 D14–D16 的剧本，D18 起挪到这里，本天不改
  ship/               本天新增的九个文件
    paths.ts          包根 / 项目根 / 用户目录三个根
    version.ts        版本号的唯一真源 + --version 那一行
    config-layers.ts  五层配置、来源追踪、密钥闸（TODO(3)、TODO(4)）
    doctor.ts         首次运行的人话引导（TODO(5a)）
    update.ts         版本检查：失败静默、有超时、有节流（TODO(5b)）
    boot.ts           启动前四件事的顺序
    task.ts           一次性任务模式 --task，非交互下默认只读
    help.ts           --help 的正文
    skill-roots.ts    技能的三个来源：包内 / 用户 / 项目
  cli.ts              来自 D20，本天扩写：多了七个开关
  index.ts            来自 D20，本天改了一处：REPL 之前多了四条立刻退出的支线
  repl.ts             来自 D20，本天改了一处：扫技能改走 ship/skill-roots.ts
  selftest.ts         本天重写：十四项断言
work/                 运行时产物，交付前清空
dist/                 构建产物（被根 .gitignore 忽略），pnpm build 生成
```

★ 标记的文件是全课地基，**一个字节都不要改**。

> **`mock-scenes.ts` 有两个，它们是不同的东西。** 顶层那个 `src/mock-scenes.ts`（325 行）
> 装的是 D14–D16 那批剧本；`src/agents/mock-scenes.ts`（207 行）装的是 D17 子 Agent 那批，
> 由 `pickAgentScene` 早退接进来。名字撞了是历史，**不要把它们合并成一个文件**。

- `starter/`：挖了五个练习点（`TODO(1)`–`TODO(5)`），`pnpm typecheck` 干净，自检 4/14
- `solution/`：参考答案，自检 14/14，`pnpm verify:pack` 五项全绿

> 说明：本实验的起点代码是 **D20** 的答案，`kernel/`、`tools/`、`skills/` 与
> `providers/` **一行都没改**。今天的新增全部落在 `ship/`、`bin/`、`scripts/` 三处，
> 以及 `cli.ts` / `index.ts` / `repl.ts` 三个接线点——**发布这件事不该要求你回去动业务代码**，
> 如果它要求了，多半说明前面某处把「配置」和「逻辑」焊在了一起。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env

# 验收入口：全课二十一天统一用这一条
MOCK=1 SELFTEST=1 pnpm start

# 打包验证（几十秒，要联网装 dotenv）：打包 → 临时前缀 → 陌生目录里跑 → 全部清掉
pnpm verify:pack

# 主现象一：配置分层，同一个 model 四层各赢一次
MOCK=1 pnpm start -- --config
LLM_MODEL=env-model MOCK=1 pnpm start -- --config
LLM_MODEL=env-model MOCK=1 pnpm start -- --config --model flag-model

# 主现象二：一次性任务模式。不加 --yes 时写操作被拒，加了才真动手
rm -rf work
MOCK=1 pnpm start -- --task "修一下失败的测试"
rm -rf work
MOCK=1 pnpm start -- --task "修一下失败的测试" --yes

# 主现象三：没有 key 时的第一屏是人话而不是堆栈（注意不要带 MOCK=1）
env -u LLM_API_KEY pnpm start -- --task "随便说点什么"

# REPL 还是原来那个，一个键都没变
rm -rf work
printf '/skills\n/exit\n' | MOCK=1 pnpm start
```

## 装到自己机器上怎么用

`pnpm verify:pack` 跑的是临时前缀，跑完就清掉了。真想留在机器上用，两条路：

```bash
# 路线一：从本地目录全局装（改完代码要重装一次）
cd solution
pnpm build
npm i -g .            # bin 名字叫 mca
mca --version
mca --help

# 路线二：不装，直接软链（改完代码立刻生效，开发期更顺手）
cd solution
pnpm build
npm link
mca --config
```

装完之后它就是一条普通命令了，**在任何目录里都能跑**：

```bash
cd ~/你的仓库
export LLM_API_KEY=你的key            # 或者写进当前目录的 .env
mca                                    # 进 REPL
mca --task "看看这个仓库是干嘛的"      # 跑一次就退出，默认只读
mca --task "把 README 的标题改一下" --yes   # 显式授权写操作
```

三层配置放在这三个地方，优先级从低到高：

```text
~/.mca/config.json          这台机器上我个人的默认
<你的仓库>/.mca/config.json  这个仓库的团队约定（进 git）
环境变量 / 命令行参数        这个终端 / 这一次
```

配置文件只认两个键，**密钥一个都不许写进去**：

```json
{ "baseUrl": "https://你的网关/v1", "model": "你要的模型id" }
```

技能也是三层，同名时离项目最近的那份赢：包内 `skills/` < `~/.mca/skills/` < `<你的仓库>/.mca/skills/`。

不想卸载得干净点的话：`npm uninstall -g <package.json 里的 name>`（或者 `npm unlink -g`）。

> **一条本课的取舍要说在前面**：`mca` 启动时会在当前目录下生成 `work/repo` 这个
> 练习用的沙盒仓库（`seed.ts` 是第一天就冻结的文件）。真实工具当然不该往用户仓库里
> 写东西——这是课程为了「每天的现象可复现」付的代价，不是推荐做法。要拿它当日用工具，
> 第一件该改的就是这个：把运行时产物挪到 `~/.mca/` 下面去。

## 验收标准

- [ ] `MOCK=1 SELFTEST=1 pnpm start` 打印 `14/14 通过`
- [ ] 构建对账那一项：`src` 下每个文件（125 个）在 `dist` 里都有对应物，含两个非 TS 资产 `servers/notes-stdio.mjs`（D15）与 `tasks/worker.mjs`（D18）
- [ ] 打包清单那一项：`dist` / `bin` / `skills` 都在包里，`src` 与 `.env` 都不在
- [ ] 分层那一项：同一个 `model`，用户 / 项目 / 环境变量 / 命令行参数各赢一次
- [ ] 密钥那一项：配置文件里的 `apiKey` 被忽略**并且警告了**，`--config` 的输出里没有明文
- [ ] 非交互那一项：不加 `--yes` 时写操作被拒且 `calc.js` 一字未改；加了 `--yes` 才真修绿
- [ ] `pnpm verify:pack` 五项全绿，且跑完临时前缀、临时目录与 `.tgz` 都没了
- [ ] `pnpm typecheck` 无输出

> **哪些数字可复现：** 自检打印的每一项都可复现——文件数、包内文件数、分层结论、
> 打码后的位数、被拒次数。包体积（solution 实测 192 KB / 包内 134 个文件）在同一份代码同一个 npm 上
> 也是稳定的。**不可复现的是安装耗时**：它取决于网络与 npm 缓存，所以这条验证脚本
> 一个耗时数字都不打印。今天全程不需要真实模型 key，但 `pnpm verify:pack` 那一步
> 要联网（npm 要去装 `dotenv`）。

## 常见坑

- **不要把 `tsx` 写进 `dependencies` 来让 TS 直接跑。** 它是个几十兆的构建工具，全局安装的 CLI 多一个运行时依赖就多一份「用户那边装不上」的概率。编译成 JS 发 `dist`，运行时依赖仍然只有一个 `dotenv`——这条零依赖纪律从第一天守到最后一天。
- **`tsc` 不会搬非 TS 文件。** `src/servers/notes-stdio.mjs`、`src/tasks/worker.mjs` 这种要被 spawn 起来的子进程、模板、静态页、数据文件，`tsc` 一个都不管。本地跑的是 `tsx src/index.ts`，根本没用 dist，所以**这类故障在本地永远复现不出来**，装到别人机器上才报 `MODULE_NOT_FOUND`。
- **搬资产要按目录遍历，不要手写文件清单。** 手写清单在加第一个新文件的那天就过期了，而且没有任何东西会报错——本天的 `src/tasks/worker.mjs`（D18 加的）就是现成的例子：没有人为它改过 `build.mjs` 一个字，它自己跟着进了 `dist` 也进了包。同理 `files` 字段写 `["dist", "bin", "skills"]`，不要写 `["dist/index.js", ...]`。
- **`bin` 脚本第一行必须是 shebang。** 类 Unix 上 npm 给它建的是符号链接，执行它的是 shell 不是 node；少了那行，报的是 `syntax error near unexpected token` 这种完全指不到病根的错。
- **配置的优先级不要凭感觉排。** 作用范围越窄的越大：命令行参数 > 环境变量 > 项目配置 > 用户配置 > 内置默认值。排反了的症状是「我加了参数但没生效」，而且不会有任何报错。
- **每个值都要能说出自己从哪来。** 配置分层最常见的支持问题不是「值错了」，是「我不知道它为什么是这样」。`--config` 打印来源不是调试功能，是这套分层能不能用的前提。
- **密钥不许进配置文件。** 项目配置要进 git，用户配置明文躺在家目录里，两者都会被备份、同步盘和「你把配置发我看看」顺走。读到就**拒绝并警告**——静默忽略的后果是用户明明写了 key 却一直被告知没有 key，他会以为工具坏了。
- **`--config` 的输出必须打码。** 日志、截图、issue 里最常见的泄漏就是有人把配置输出整段贴出来。
- **更新检查不许有能力弄崩启动。** 失败一律静默、必须带超时、一天查一次、离线模式不查。没有超时的网络请求等于把别人的可用性接进了自己的启动路径。
- **首次运行不要给堆栈。** 那是这个工具唯一一次不需要争取就能得到的注意力。人话要回答三件事：缺什么、敲哪条命令补上、不想补能不能先看看（`MOCK=1` 这条退路必须给）。
- **非交互模式的审批默认答案必须是拒绝。** 交互模式里「没回答」是用户在犹豫，非交互模式里「没回答」是常态；当成同意等于给所有 CI 发了一张无限授权。而且被拒时要把原因说给模型听，让它改走只读的路，不要原地重试。
- **全局安装之后「包在哪」和「用户在哪」是两个地方。** 随包分发的资产从 `import.meta.url` 上溯去找，用户的东西绝不从包根找。本地这两个根恰好是同一个目录，所以这类 bug **本地一次都不会出现**。
- **验证安装不要往全局环境里装。** 用 `npm i -g --prefix <临时目录>`，跑完连同 `.tgz` 一起删掉。
