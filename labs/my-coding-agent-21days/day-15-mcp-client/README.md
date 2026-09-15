# D15 实验：一个零依赖的 MCP 客户端，能同时挂载 stdio 与 HTTP 两个 server

> 目标：把别人的工具接进 `mca`。今天**不引任何 SDK、不引任何 JSON-RPC 库**，
> 自己按 2026-07-28 规范拼报文，写两种传输：stdio（把 server 当子进程拉起来）与
> Streamable HTTP（POST 过去，响应可能是一个 JSON，也可能是一条事件流）。
> 然后把两个 server 的工具聚合进本地清单、加命名空间前缀，最后让它们**原样复用**
> 第五天那道审批门与第三天那条截断。
>
> 现象最好看的两条：两个 server 各有一个 `search`，进了清单之后变成
> `mcp__notes__search` 与 `mcp__tickets__search` 互不打架，而**发回 server 的仍然是原名**；
> 以及把工单系统的地址指到一个空端口上，笔记库的三个工具照常可用——
> **一个 server 挂掉，最坏的后果是少几个工具，不是这一轮对话失败。**

## 你会学到

- 无状态协议下的一条请求长什么样：为什么版本与能力要写进**每一条**请求的 `_meta`，而不是握手一次
- 手写 JSON-RPC 的四件事：发号、按 id 配对、超时、传输死掉时一次性收摊
- `tools/list` 是分页的，而**判据只有一条：`nextCursor` 缺失才是结束**
- stdio 传输的真实坑：**半行报文**（一次 `data` 事件不是一行）、日志必须走 stderr、子进程不会跟着父进程死
- Streamable HTTP 的两种响应形状，以及为什么**不能假设「流里最后一条就是响应」**
- 这一版删掉了什么：会话头、GET 长连接、断流续传——照着老教程写会直接踩空
- 必填请求头（`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`）为什么存在，以及头体不一致为什么是**漏洞**而不是笔误
- 命名空间前缀为什么必须来自**客户端自己的配置别名**，反查为什么只能走表不能切字符串
- 信任边界：为什么 server 自报的 `readOnlyHint` **不能**用来决定要不要审批
- 失败隔离的三条：发现阶段逐个 try/catch、调用阶段一律不抛、掉线要让用户看得见

## 目录

```text
src/
  seed.ts             ★ 冻结（D1 定稿），本天不改
  providers/          ★ 冻结（D1 与 D2 定稿），本天不改
  kernel/             来自 D14，本天一行都没改（**这是今天最值得注意的一件事**）
  tools/ refs/ context/ plan/ snapshot/ session/  来自 D14，本天不改
  mcp/                本天新增的八个文件
    protocol.ts       2026-07-28 的常量、类型、withMeta、resultText
    transport.ts      Transport 接口 + LineFramer（半行报文）（TODO(1)）
    stdio.ts          stdio 传输：子进程生命周期、stderr 分流
    http.ts           Streamable HTTP 传输：必填头、两种响应形状、SSE（TODO(3)）
    client.ts         发号、按 id 配对、超时、翻页（TODO(2)）
    mount.ts          聚合：命名空间、信任边界、失败隔离（TODO(4)、TODO(5)）
    servers.ts        挂哪几个 server（只读环境变量，配置文件是 D21 的题目）
    commands.ts       /mcp 一条命令
  servers/            本天新增的两个**演示 server**——它们不是练习，是你的连接对象
    notes-stdio.mjs   笔记库（stdio）：3 个工具，但 tools/list 每页只回 2 个
    tickets-http.ts   工单系统（Streamable HTTP，端口 3115）：2 个工具，和笔记库撞了一个 search
  session-factory.ts  本天从 commands.ts 搬出来：Session 的形状与工具注册表的唯一出口
  session/open.ts     本天从 repl.ts 搬出来：开会话 / 接会话 / --sessions
  commands.ts         来自 D14，本天改了两处：搬走会话工厂、展开 MCP_COMMANDS
  repl.ts             来自 D14，本天改了一处：启动时先挂 MCP、退出时收摊
  system-prompt.ts    来自 D14，本天多了三句：远端工具是别人的数据、要审批、掉线要说出来
  mock-script.ts      来自 D14，本天加了一场 MCP_FLOW：连调两个远端工具
  selftest.ts         本天重写：十四项断言
work/
  repo/ sessions/ snapshots/   来自 D14，本天不改
```

★ 标记的文件是全课地基，后面每天原样复制，**一个字节都不要改**。

- `starter/`：挖了五个练习点（`TODO(1)`–`TODO(5)`），typecheck 干净，自检 4/14
- `solution/`：参考答案，自检 14/14

> 说明：本实验的起点代码是 **D14** 的答案，而 `kernel/` **一行都没改**。
> 这件事本身就是今天的结论：远端工具在循环眼里只是又一个 `ToolDef`，
> 所以截断（D3）、审批（D5）、打转检测（D6）、快照（D14）全都白拿。
> 本天的两次搬家（`session-factory.ts`、`session/open.ts`）是纯搬运，逻辑没有任何变化，
> 原因是 `commands.ts` 到了 337 行、`repl.ts` 到了 360 行，而本课单文件上限是 350。

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env

# 验收入口：全课二十一天统一用这一条。它会自己把两个演示 server 起起来
MOCK=1 SELFTEST=1 pnpm start

# 主现象一：两个 server 的工具都挂上了，两个 search 各归各的命名空间
rm -rf work
printf '/mcp\n/exit\n' | MOCK=1 pnpm start

# 主现象二：模型连调两个远端工具（一个 stdio、一个 HTTP），两次都停下来等审批
rm -rf work
printf '动手之前先查查团队笔记和工单\ny\ny\n/exit\n' | MOCK=1 pnpm start

# 主现象三：失败隔离。把工单系统指到一个空端口，笔记库的三个工具照常可用
rm -rf work
printf '/mcp\n/exit\n' | MOCK=1 MCP_TICKETS_URL=http://127.0.0.1:3199/mcp pnpm start

# 完全不挂 MCP：mca 退回到只有八个本地工具的样子
rm -rf work
printf '/mcp\n/exit\n' | MOCK=1 MCP=off pnpm start

# 想单独起那个 HTTP server（比如用 curl 手动打一条报文看看）
pnpm exec tsx src/servers/tickets-http.ts
```

> **端口 3115 必须空着。** 演示用的工单系统 server 监听在这里，自检也会起它一次。
> 端口被占时 mca 不会崩，它会打一行提示然后直接连已经在那儿的那个——
> 但如果占着它的不是这个 server，你会看到一堆莫名其妙的协议错误。

> **哪些数字可复现：** `MOCK=1 SELFTEST=1 pnpm start` 打印的每一项都可复现（连跑两次
> diff 为空）：工具条数与名字、翻页结果、通知条数、截断后的字符数、错误码、掉线表。
> **唯一的外部条件是 3115 端口空着。** 今天没有任何一项断言去比耗时——
> 超时那一项比的是「有没有在上限内失败」，不是具体用了多少毫秒。

> `pnpm install --ignore-workspace` 可能以非 0 退出并打印 `Ignored build scripts: esbuild`，
> 这不代表安装失败——看 `node_modules` 有没有生成、`pnpm typecheck` 过不过就够了。

## 验收标准

- [ ] `MOCK=1 SELFTEST=1 pnpm start` 打印 `14/14 通过`
- [ ] 翻页那一项：笔记库每页只回 2 个，翻完拿到 3 个工具（写死取第一页的话这里是 2）
- [ ] 事件流那一项：一次 `tools/call` 收到 1 条通知 + 1 条按 id 配对的响应
- [ ] 命名空间那一项：两个 `search` 变成 5 个互不冲突的本地名，反查能指回 `别名:原名`
- [ ] 信任边界那一项：server 声明 `readOnlyHint: true` 的 `search` **照样**停下来等审批
- [ ] 失败隔离那一项：工单系统掉线时笔记库的 3 个工具照常可用，调掉线工具拿到的是 `ok: false` 而不是异常
- [ ] `pnpm typecheck` 无输出

## 常见坑

- **不要按 `chunk.split('\n')` 直接分帧。** 一次 `data` 事件拿到的是「上次剩下的半行 + 这次的若干行 + 这次剩下的半行」，操作系统只保证字节顺序，不保证边界。这个 bug 特别阴：小结果一切正常，大结果偶尔报错，本机好好的换台机器就坏。必须留一个缓冲区，**只把带换行的那部分交出去**。
- **不要写死取 `tools/list` 的第一页。** 判据只有一条：**`nextCursor` 缺失才是结束**。不要用「这一页比上一页少」去猜（规范没保证服务端把每页填满），更不要去解析游标（它对客户端不透明）。写错的表现是用户少看见几个工具，而没有任何东西报错。
- **不要假设「事件流里最后一条就是响应」。** 流里混着通知，服务端完全可以在结果之后再发一条日志通知。判据是**带 id 且 id 对得上**的那条才是响应。顺带一条：**流结束不等于请求成功**，中途断掉要主动报错，否则调用方会一直等到超时，而真正的原因再也看不见了。
- **不要不设超时。** stdio 上服务端不回你就永远不回，那个 `await` 会一直挂着，整个 Agent 就停在那儿。超时值定多少没有标准答案，**但不设一定是错的**。
- **传输死掉时要把所有在等的请求一次性失败掉。** 不这么做，server 起不来（命令拼错、依赖缺失）时每一条请求都要各等满一次超时，一次发现就是十几秒干等。
- **server 的日志只能走 stderr。** 它往 stdout 多打一个字，客户端的 `JSON.parse` 就开始报错，而报出来的错长得像「协议坏了」，跟日志毫无关系。客户端这边对应的护栏是：一行解析不了只记一笔，**不要杀掉整个传输**。
- **子进程不会跟着父进程一起死。** 退出时要显式 `kill`，先 `end` stdin 再 `kill`。漏了这一步，跑几次之后机器上会留一串孤儿 server 进程。
- **命名空间前缀必须来自客户端自己的配置别名。** 规范只保证工具名在**单个 server 内**唯一，而且明说服务端自报的 `serverInfo.name` 不保证跨 server 唯一、不该拿它消歧。别名撞了是配置错误，**要在启动时炸**，而不是等模型调错工具。
- **反查只能走表，不能切字符串。** 工具原名里本来就允许有下划线（`read_note`、`close_ticket`），被截断加哈希过的更是拆不回来。
- **超长名截断之后必须缀哈希。** 截断本身会制造新的重名，哈希是用来把唯一性补回来的。
- **发回 server 的必须是原名。** 带命名空间的名字只在模型与客户端之间流通，server 根本不认识它。这个 bug 的表现是所有远端调用都回 `-32602 没有这个工具`。
- **不要采信 server 自己声明的 `readOnlyHint`。** 那是被调用方给自己发的通行证。规范也要求客户端把工具注解当成不可信输入。本课的口径是**远端工具一律按「会改东西」对待**，全部落进第五天那道门的 ask 分支。
- **协议错误与工具执行错误要分开。** 响应里带 `error` 的是协议错误（工具不存在、版本不支持、头体不一致），模型改不了；`isError` 为真的是**成功响应**里的执行错误，它是给模型看的，要原样回灌让它换个参数再试。把后者也抛成异常，模型就永远等不到「你的参数写错了」这句话，一次本来能自愈的调用变成一次失败。
- **调用阶段一律不抛。** 工具名不存在、server 掉线、调用超时，全部翻译成 `ok: false` 的结果。一个 server 挂掉，最坏的后果应该是少几个工具，不是这一轮对话失败。
- **掉线要让用户看得见。** 把掉线的 server 悄悄从清单里拿掉，模型会表现得像那个能力从来不存在，只说「我查不到相关工单」。**少了一只手是事故，装作从来没长过那只手是更大的事故。**
- **照老教程写会踩空。** 2026-07-28 删掉了 `initialize` 握手、`Mcp-Session-Id` 会话头、GET 长连接、`Last-Event-ID` 断流续传，还禁止服务端主动发起 JSON-RPC 请求。这些不是弃用，是删除。
- **挂载要在建会话之前。** 工具注册表是在 `newSession` 里一次性造出来的，挂晚了远端工具就进不了那张表，而且不会有任何东西报错——模型只是从头到尾不提它们。真要做「运行中挂载」，代价是**动态增删工具会打掉提示缓存**（工具表在提示前缀里），那是另一个决定。
