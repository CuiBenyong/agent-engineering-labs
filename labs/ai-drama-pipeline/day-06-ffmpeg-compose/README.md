# D6 实验：把一集全部素材合成竖屏成片与封面的合成环节

> 目标：把「四个镜头视频 + 四段配音 + 四句字幕」剪成一条 1080x1920 的成片和一张封面，
> 而且每一条 ffmpeg 参数都是从时间轴表算出来的——没有一处是人手敲的时间，也没有一处让模型写命令。

## 你会学到

- 把分镜、音频、字幕汇总成一张带起止时间的时间轴表
- 由时间轴表生成 ffmpeg 参数并执行，产出一条完整的竖屏成片
- 叠加字幕与背景音轨，用播放器确认音画同步且字幕不出安全区
- 从指定时间点截出封面图，并按平台尺寸导出
- 故意把某一镜的时长改错，观察成片出现的现象并定位到时间轴表

## 目录

- `starter/`：挖了 5 个练习的起始代码，`MOCK=1` 下可以直接跑（但跑出来的成片是残的）
- `solution/`：参考答案
- 两侧的 `src/providers/`、`src/ffmpeg.ts`、`src/run.ts`、`src/dag.ts` **来自 D1，本天不改**
- 本天新增的教学代码只有三个文件：
  - `src/timeline.ts`：时间轴表与 SRT 生成（结构由 D5 定义，本天只消费）
  - `src/compose.ts`：把时间轴翻译成 ffmpeg 参数，本天的主角
  - `src/episode.ts`：写死的分镜与人物卡，真实流水线里来自 D2 与 D3

## 怎么跑

需要本机装好 ffmpeg（含 `ffprobe`）：

```bash
brew install ffmpeg                      # macOS
sudo apt-get install -y ffmpeg           # Debian / Ubuntu
```

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace
cp .env.example .env  # 填 MINIMAX_API_KEY；没有 key 就一直用 MOCK=1
MOCK=1 pnpm start                        # 离线占位素材，零外部依赖
MOCK=1 TRANSITION=fade pnpm start        # 换成 xfade 滤镜图那条路
MOCK=1 BREAK_SHOT=s02:2 pnpm start       # 把 s02 的时长改错，复现「台词说不完」
WORK_DIR=~/drama-out pnpm start                               # 真实厂商（会花钱）（产物写仓库外：花过钱的素材别放临时目录）
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 pnpm start` 跑完，`work/runs/<runId>/output/` 下同时出现 `episode-1.mp4`、`episode-1.srt`、`cover-1.jpg`。
2. `ffprobe` 能在成片里看到三条流：`h264 1080x1920` + `aac` + `mov_text`（本机若带 libass，则是两条流、字幕已烧进画面），且视频时长与时间轴表的总时长一致。
3. 终端里能看到本机是走了烧录还是回落到软字幕，这行提示来自对 `subtitles` 滤镜的能力探测，不是写死的。
4. 封面截自第一个特写镜头的中点，不是第 0 秒；`ffprobe` 看封面是 1080x1920。
5. `MOCK=1 BREAK_SHOT=s02:2 pnpm start` 会打印一条 `⚠️ s02：台词需要 …ms，镜头只有 2000ms` 的警告，并且成片总时长跟着缩短 3 秒。

## 常见坑

- **`concat` 分离器只在各段编码参数完全一致时才能 `-c copy`。** 少了统一分辨率、帧率、采样率、声道数这一步，拼出来的片子会在第二段开始花屏、掉音，或者干脆报 `Non-monotonous DTS`。所以「先归一化每一镜，再流拷贝拼接」这个顺序不能反。
- **`drawtext` 与 `subtitles` 滤镜不是标配。** 本机 ffmpeg 9.0.1（homebrew）编译时没带 libfreetype 与 libass，这两个滤镜一个都没有。任何把它们当默认方案的教程，读者换台机器就跑不起来——必须 `ffmpeg -filters` 探测再决定走哪条路。
- **SRT 的毫秒分隔符是逗号，不是点。** 写成 `00:00:01.200` 语法看着没问题，多数播放器直接当作没有字幕，而 ffmpeg 封装时也不一定报错。
- **加转场之后成片会变短。** N 段之间有 N-1 个转场，每个吃掉 300ms，所以时间轴表必须整体重算一遍，否则字幕越到后面偏得越多。本实验的 `TRANSITION=fade` 会把这一步做出来给你看。
- **`-ss` 放在 `-i` 前面是关键帧级定位。** 截封面够用，但要精确到某一帧就得放到 `-i` 后面，代价是从头解码到那一秒。
- **背景音乐不能随手拿。** 实验里的背景音是 ffmpeg 现场生成的正弦波占位，真实发布必须用你有授权的音乐——这条红线在 D5 与 D11 还会展开。
