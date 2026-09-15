# D1 实验：一张生产线任务图与一个能在离线模式下跑通全流程的四类 provider 骨架

> 目标：把「一句话 → 一集短剧」的六道工序写成一张任务图，配上文本 / 图像 / 视频 / 语音四类
> provider 接口和它们的离线实现，让整条线在没有密钥、没有余额、没有网络的情况下也能跑完，
> 并在 `work/runs/<runId>/` 下留下每一步的真实产物文件。这是后面十三天共用的地基。

## 你会学到

- 画出你自己的生产线任务图，标出每个节点的输入产物与输出产物
- 定义四类 provider 接口，并各写一个离线实现，让它真的产出占位图与占位视频文件
- 用一条命令跑通「一句话进、一个目录的占位素材出」，确认每一步都留下了产物
- 把同一份业务代码接上真实厂商实现，只改环境变量，不改业务代码
- 记录离线与真实两条路径上分别看到的现象差异

## 目录

- `starter/`：挖了 4 个编号练习的起始代码，`MOCK=1` 下可以直接跑（跑出来的东西一眼能看出没做完）
- `solution/`：参考答案

两边的 `src/` 结构相同：

```text
src/
├── index.ts            六个节点的任务图与账单打印（当天真正要读的部分）
├── dag.ts              拓扑排序与按图执行
├── run.ts              一次运行的目录布局与成本台账
├── ffmpeg.ts           ffmpeg 的最小封装：探测、执行、读时长
└── providers/
    ├── types.ts        四类 provider 接口与全课公共数据结构
    ├── mock.ts         离线实现：产出真的占位图 / 占位视频 / 占位音频
    ├── minimax.ts      真实实现
    └── index.ts        唯一的选择点：createProviders()
```

`src/providers/` 是全课的公共底座，D2 到 D14 会原样复制这一层，接口签名不再改动。

## 怎么跑

先装好 ffmpeg（本实验的占位素材全靠它）：

```bash
brew install ffmpeg                      # macOS
sudo apt-get install -y ffmpeg           # Debian / Ubuntu
```

然后：

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 MINIMAX_API_KEY；没有 key 就一直用 MOCK=1
MOCK=1 pnpm start                          # 离线占位，用默认的一句话
MOCK=1 pnpm start "退休法医在菜市场认出了通缉犯"   # 离线占位，换一句话
WORK_DIR=~/drama-out pnpm start                                 # 真实厂商（要 key，要余额）（产物写仓库外：花过钱的素材别放临时目录）
```

产物在 `work/runs/<runId>/` 下，`work/` 已经在仓库根 `.gitignore` 里，不会被提交。

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 pnpm start` 跑完，终端按 script、assets、frames、clips、voice、timeline 六个节点逐个打印耗时与产物数，最后一行账单显示产物 14 个。
2. `work/runs/<runId>/` 下真的有文件：两张角色定妆图、三张首帧、三段 `clip.mp4`、三段 `voice-1.mp3`、`script/` 与 `timeline/` 两份 JSON、一份 `run.json`。
3. `ffprobe work/runs/<runId>/shots/s01/clip.mp4` 能看到 `1080x1920`、`h264` 与 `aac` 两条流、时长 6 秒。
4. 三张首帧 `first-frame.png` 的颜色互不相同（占位色由镜头描述哈希得来，不是同一块灰）。
5. `timeline/episode-1.json` 里三镜的时间首尾相接：`0–6000`、`6000–12000`、`12000–18000`，不重叠也不留缝。
6. 把 `script` 节点的 `deps` 改成 `['timeline']` 造一个环，再跑就会报「任务图里有环」并直接退出，而不是跑出一半的结果。

`starter/` 原样跑时第 3、4、5、6 条都是不达标的，做完四个练习后应当全部达标。

## 常见坑

1. **不要用 `drawtext`、`subtitles`、`ass` 这三个滤镜。** homebrew 装的 ffmpeg 常常只带 `--enable-gpl --enable-libx264`，没有 libfreetype 和 libass，用了这几个滤镜读者那边会直接报错跑不起来。占位素材只用 `color`、`testsrc2`、`sine` 这三个 lavfi 源就够了。
2. **占位视频忘了加音轨，问题要到第 6 天才爆。** 只有画面的 mp4 单独看没问题，但合成时几段有音轨、几段没有，`concat` 出来的流数量对不上，排查起来非常绕。所以离线视频也必须带一条 `sine` 音轨。
3. **`MOCK=1` 只能打在网络出口上。** 桩要写在 `providers/mock.ts` 里，不要在业务代码里到处写 `if (process.env.MOCK)`。判据是「改一句话输入，产出必须跟着变」——占位图颜色、占位音高、配音时长都随输入变，才说明业务逻辑真的跑了。
4. **图片和视频的下载链接都是临时的。** 真实实现里 `image_urls` 24 小时后失效，视频要先拿 `file_id` 再换 `download_url`，两者都必须当场下载落盘。把 URL 存进数据库当作产物，第二天就打不开了。
