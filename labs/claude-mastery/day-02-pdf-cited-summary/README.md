# D2 实验：读一份 PDF 并输出带页码引用的摘要

> 目标：用官方 SDK 把一份 PDF 整本发给 Claude，拿到每句话都能指回页码的摘要；再给文档块打上缓存断点，用 usage 字段亲眼验证第二次提问只付零头。这是你第一次用代码调 Claude，也是以后接任何「长文档问答」需求的最小骨架。

## 你会学到

- 用官方 SDK 发第一次请求，打印文本块与 usage
- 把 PDF 读成 base64 装进 document 块，开启 citations
- 遍历返回的内容块，把每条 citation 的页码拼到句子后面
- 给 document 块加 cache_control，连问两次并对比 usage 里的缓存字段
- MOCK=1 下离线返回固定的带引用结果，方便没有密钥时也能跑

## 目录

- `sample.pdf`：自带的 4 页示例文档（内容就是本课示例任务的评审报告），没有自己的 PDF 时用它
- `starter/`：挖了 3 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案；`solution/summarize.py` 是同一件事的 Python 版（不走 pnpm，`pip install anthropic` 后直接跑）

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 ANTHROPIC_API_KEY；没有 key 先用 MOCK=1
MOCK=1 pnpm start ../sample.pdf                  # 离线模拟（一次性脚本，不用管道喂输入）
pnpm start ../sample.pdf                         # 真模型，默认两个问题
pnpm start ../sample.pdf "这份文档的作者是谁？"     # 自定义问题
MODEL=claude-haiku-4-5-20251001 pnpm start ../sample.pdf   # 换更便宜的模型
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`（各自目录下的 `.npmrc` 已经写了 `ignore-workspace=true`）。
> `pnpm install` 可能因为依赖的构建脚本被拦截而以非 0 退出，这不代表安装失败——看 `node_modules` 是否生成、`pnpm typecheck` 是否通过。

## 验收标准

1. `MOCK=1 pnpm start ../sample.pdf` 离线打印出一段摘要，每句话后面带形如 `[p.3]` 的页码标记。
2. 有真实密钥时 `pnpm start ../sample.pdf` 输出的每个页码都能在 PDF 里翻到对应原文。
3. 连续问两次，第二次打印的 `cache_read` 明显大于 0，`cache_write` 为 0。
4. 把 `max_tokens` 改小到摘要被截断，程序会明确打印 `stop_reason=max_tokens` 的警告而不是静默输出半截。
5. 文档超过页数上限或不是 PDF 时，程序给出可读的错误提示。

## 常见坑

1. **base64 里有换行。** 有些工具生成的 base64 每 76 个字符插一个换行，API 会拒绝。Node 的 `Buffer.toString('base64')` 与 Python 的 `base64.standard_b64encode` 都不会插换行，别用命令行 `base64` 的默认输出。
2. **把 text 块放在 document 块前面。** 能跑，但模型先看到问题再读几十页材料，回答质量明显下降。材料在前、指令在后。
3. **第二次提问 cache_read 还是 0。** 按顺序查：两次请求的 `MODEL` 是否一致；问题是不是被你放到了 document 块前面（前缀变了）；PDF 是否太短不够最小缓存长度（主力模型 1024 token，示例 `sample.pdf` 只有 4 页，真实调用时可能就低于门槛——换一份 10 页以上的 PDF 再试）；两次间隔是否超过 5 分钟。
4. **`end_page_number` 当成包含的末页。** 它是不包含的：引用第 3 页时 `start_page_number=3, end_page_number=4`。只看 start 就不会错。
5. **把 `stop_reason=max_tokens` 的半截摘要当成完整结果。** 一定要检查 `stop_reason`，这是最常见的静默错误。
