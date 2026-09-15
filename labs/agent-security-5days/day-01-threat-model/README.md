# D1 实验：威胁建模器

读一份 Agent 配置，判定**致命三件套**是否齐全，输出一张按严重度排序、每条都带证据的风险条目表。

这一天的产出是**后面四天的地基**：`src/core/types.ts` 与 `src/core/scenario.ts` 两个文件
会被 D2–D5 原样复用（靶子 `deskmate` 全课不变），所以值得写仔细一点。

## 跑起来

```bash
cd starter        # 或 solution
pnpm install --ignore-workspace
pnpm typecheck && pnpm start
```

**纯本地计算，不连模型也不联网**——威胁建模是一件在写代码之前就该做完的事，
不需要把 Agent 跑起来。后面四天才会用到模型（也都支持 `MOCK=1` 离线）。

> `pnpm install --ignore-workspace` 可能以非 0 退出（pnpm 拦截了依赖的构建脚本），
> 这不代表安装失败。看 `node_modules` 是否生成、以及 `pnpm typecheck` 是否通过。

## 靶子：deskmate

全课共用一个虚构靶子——公司内部的知识助手 `deskmate`，它每天做三件事：

| 它做的事 | 对应的工具 | 对应三件套的哪条边 |
| --- | --- | --- |
| 读工单，以及工单里贴的网页 | `read_ticket` `fetch_page` | 接触**不可信内容** |
| 查内部客户库回答问题 | `search_customers` | 访问**私有数据** |
| 把结论发邮件 / 发通知 / 写回工单 | `send_email` `post_webhook` `update_ticket` | 能**对外通信** |

这三件事没有任何一件是 bug，每一件都是产品需求。**风险是它们的组合。**

## 三个练习点

都在 `starter/src/model/` 里用 `TODO(N)` 标出来了。

1. **`trifecta.ts`：三件套判定。** 按工具的 `sensitivity` / `returnsUntrusted` / `effect`
   三个字段推断出三条边，注意用户输入本身也是一条不可信内容来源。
2. **`trifecta.ts`：最省的一刀。** 三条边里涉及工具数最少的那条，就是最容易拆的那条。
3. **`risks.ts`：风险条目生成。** 四类条目，每条都要落到 OWASP 编号，并带上 evidence。

`solution/` 里每个函数都有注释说明为什么这么写。

## 验收标准

1. 对 `deskmate` 的判定是「三件套齐全」，三条边下面各自列出了对应的工具名
2. 风险条目里第一条是 `[CRITICAL] R-TRIFECTA`，且它的 evidence 列出了三条边各自的工具
3. 条目总数是 6 条，且严重度从高到低排列
4. 对照组 `deskmate-no-send` 的判定翻转成「三件套未齐全」，条目掉到 3 条且没有 critical
5. `pnpm typecheck` 退出码为 0

## 手动验收清单（自动断言覆盖不到的部分）

- [ ] 两份报告的**差别**符合预期：只删了两个工具，critical 条目就消失了——
      这是「拆一条边」这个判据的直观演示，不是巧合
- [ ] 每条风险都能回答「你凭什么说它是风险」：证据行里写的是配置里真实存在的工具
- [ ] 把 `DESKMATE` 的 `userInputTrust` 改成 `'trusted'` 再跑，
      不可信内容那条边**仍然成立**（因为 `read_ticket` / `fetch_page` 还在）——
      说明判定没有被单一字段绑架

## 换成自己的项目

把 `src/core/scenario.ts` 里的工具清单换成你自己 Agent 的，跑一遍：

```bash
pnpm start > ~/my-agent-threat-model.md
```

这份输出就是你自己 Agent 的威胁模型表。**它会在 D5 的检查清单里再用到一次。**
