# D3 实验：从分镜数据批量产出角色定妆图与场景资产的生成器，外加一个资产库

> 目标：给每个角色定一张基准图，再由它派生出多角度多表情的定妆图，把场景与道具一起登记进一个会去重的资产库——做完这一步，后面十一天的每一个镜头都有稳定的形象可用，而不是每次重新抽卡。

## 你会学到

- 从 D2 的人物卡出发，为每个角色生成一张主定妆图并人工挑选一张作为基准
- 以基准图为参考，派生该角色的多角度与多表情图，肉眼对比一致性差异
- 批量生成分镜里出现的场景与道具资产，并写入资产库
- 实现资产库的查找与去重，同样的描述第二次不再重新生成
- 关掉参考图再跑一遍同一组分镜，把两组结果并排放进报告里

## 目录

- `starter/`：挖了四个练习的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `src/providers/`、`src/ffmpeg.ts`、`src/run.ts`：**来自 D1，本天不改**。四类 provider 的接口与离线实现在 D1 定稿，之后每天原样复制
- `src/assets.ts`：本天新增的资产库（去重键、索引、查找）
- `src/index.ts`：本天的主流程，五步各打印一段可观察的日志

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 MINIMAX_API_KEY；没有 key 先用 MOCK=1
MOCK=1 pnpm start     # 离线占位，零外部依赖
WORK_DIR=~/drama-out pnpm start   # 真实调用图像接口（产物写仓库外）
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。
> 另外这个实验依赖 ffmpeg 生成占位图：macOS 用 `brew install ffmpeg`，Debian 用 `sudo apt-get install -y ffmpeg`。

产物都在 `work/runs/<runId>/` 下：`assets/characters/<角色 id>/*.png`、`assets/scenes/*.png`、`assets/index.json`。

## 验收标准

1. `MOCK=1 pnpm start` 跑完，`assets/characters/c1/` 下同时有 `base.png` 与三个变体，日志里三个变体后面都跟着「（带参考图）」。
2. 报告里「第 4 步重复请求的场景重新生成了 N 张」这一行的 N 是 0，且日志里能看到两条 `↺ 复用`。
3. 报告的对照表里 6 个变体全部显示「不同」——同提示词、同 seed，唯一的差别是有没有带参考图。
4. `assets/index.json` 里每条记录都带 `prompt`、`referenceImage`、`seed`，出问题时能照着复现。
5. `pnpm typecheck` 通过，没有 `any`。

## 常见坑

- **去重键拿文件路径算**：路径是你自己拼的，改一次目录结构缓存就全部失效；反过来同一个路径下换了提示词，缓存又会错误命中，读者会看到「明明改了描述，图还是老的」。键必须由**会改变画面的内容**算出来。
- **忘了把基准图路径写回人物卡**：派生那一步拿到的 `referenceImage` 是 `undefined`，程序不报错、图也照出，只是每张脸都不一样。对照表全部显示「相同」就是这个症状。
- **参考图传了本地路径**：接口要的是公网 URL 或 Base64 Data URL，直接把 `work/...` 这种相对路径发过去会被判参数无效。离线模式不会暴露这个问题，接上真实 key 的第一次调用才会。
- **图片链接过期才发现没落盘**：MiniMax 返回的图片 URL 只有 24 小时有效期，下载落盘必须是流程的一部分。把 URL 存进索引、图不存，第二天整个资产库就空了。
