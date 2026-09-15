// 作品集材料：一段演示视频、一张架构图、一份说明文档。
//
// 三样东西对应三种读者：演示视频给三分钟就走的人，架构图给技术面试官，
// 说明文档给会认真读完的人。缺一样，这个项目在别人眼里就只是"跑了个脚本"。

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ffmpeg } from './ffmpeg.js'
import type { SeasonSummary } from './ledger.js'
import type { World } from './world.js'

/** 演示片花：每集抽第一镜拼一条，流复制拼接，不重新编码。 */
export async function buildDemoReel(
  clips: string[],
  outPath: string,
  listPath: string
): Promise<void> {
  await mkdir(resolve(outPath, '..'), { recursive: true })
  await writeFile(
    listPath,
    clips.map((c) => `file '${resolve(c).replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  )
  // 练习 4：把这里改成流复制拼接。
  //   五段片花本来就是同一套编码参数，用 -c copy 直接拼，一次都不用重新编码；
  //   现在这句在重新压一遍，日志里能看到 libx264，画质白掉一次、时间白花一截。
  await ffmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    outPath,
  ])
}

export const ARCHITECTURE_MMD = `flowchart TD
  idea[一句话选题] --> script[剧本 Agent<br/>结构化分镜 + 自动评审]
  world[(世界观档案<br/>人物 / 风格 / 钩子)] --> script
  script --> assets[角色与场景资产<br/>定妆图 + 参考图复用]
  assets --> frames[每镜首帧]
  frames --> clips[镜头视频<br/>异步任务轮询]
  script --> voice[配音与字幕]
  clips --> compose[ffmpeg 合成<br/>竖屏成片 + 软字幕]
  voice --> compose
  compose --> qc[质检与合规<br/>机器审片 + 生成内容标识]
  qc --> release[多平台发行<br/>一次渲染多次封装]
  engine[[工作流引擎<br/>幂等 / 断点续跑]] --- clips
  gate[[并发闸门与配额]] --- clips
  budget[[成本路由与预算熔断]] --- clips
  console[[人机协作审核台]] --- qc
  release --> data[数据回收<br/>留存曲线映射回环节]
  data --> script
`

export function portfolioReadme(
  world: World,
  s: SeasonSummary,
  checksPassed: number,
  checksTotal: number
): string {
  return `# ${world.title} —— 一条 AI 短剧生产线

${world.logline}

## 这是什么

一条从「一句话选题」到「多平台可发布成片」的自动化内容生产线。一次运行产出一季 ${s.episodes} 集竖屏短剧，
中途只在需要人判断的地方停下来等人。整条线的模型调用走统一的 provider 抽象，
离线模式下不需要任何密钥即可跑通全流程。

## 一次真实运行的数字

| 指标 | 值 |
| --- | --- |
| 集数 | ${s.episodes} |
| 端到端耗时 | ${(s.totalMs / 1000).toFixed(1)} 秒（离线占位模式） |
| 模型调用次数 | ${s.attempts} |
| 失败与重试 | ${s.failures} 次（失败率 ${(s.failureRate * 100).toFixed(1)}%） |
| 人工介入 | ${s.manualTouches} 次 |
| 花费（按公开单价估算） | ¥${s.totalCny.toFixed(2)}，单集 ¥${s.perEpisodeCny.toFixed(2)} |
| 跨集一致性检查 | ${checksPassed} / ${checksTotal} 项通过 |

> 花费是按厂商公开单价乘用量算出的估算值，不是账单；离线模式下没有真实调用。

## 三个可以细讲的技术故事

1. **围着「少调一次视频接口」做的整套工程设计。**
   视频生成是全线最贵最慢最容易失败的一环，占单集成本九成以上。
   幂等键、产物缓存、参考图复用、草稿档与成片档分档路由、预算熔断，
   全部是这一条判断的推论——不是攒了一堆最佳实践。

2. **异步任务的客户端怎么写才不会把自己拖死。**
   提交、轮询、取件、下载四步里每一步都会失败，而失败还分能重试与不能重试两类。
   状态机 + 指数退避 + 超时放弃 + 按错误码分类，加上「失败的视频不扣费」这类计费口径，
   决定了这条线在配额受限的真实环境里能不能跑满。

3. **人该站在流水线的哪一格。**
   全自动会产出一堆没人看的片子，全人工又跑不动量。
   审核台把人放在"质检之后、发行之前"这一格，并把「改一句台词」翻译成
   「哪些下游节点需要重算」，人工介入次数因此成了一个可以被优化的指标。

## 目录

\`\`\`
work/runs/<runId>/
├── run.json                 本次运行的元信息与成本台账
├── script/                  世界观档案、人物卡、每集分镜
├── shots/<shotId>/          首帧、镜头视频、配音
├── timeline/                时间轴表
└── output/
    ├── episode-<n>.mp4      各集成片
    └── portfolio/
        ├── README.md        本文件
        ├── architecture.mmd 架构图（mermaid）
        └── demo.mp4         演示片花
\`\`\`

## 怎么跑

\`\`\`bash
pnpm install --ignore-workspace
MOCK=1 pnpm start            # 无密钥、无网络，跑通全流程
cp .env.example .env         # 填 MINIMAX_API_KEY 后去掉 MOCK=1，跑真实厂商
\`\`\`

## 还能往哪走

把这条线上反复用到的判断（分镜怎么切、提示词怎么拼、失败怎么分类）从代码里提出来，
沉淀成一份可复用的能力包，换一个题材、换一个厂商时不用重写流程。

## 说明

- 代码 MIT。
- 生成内容按《人工智能生成合成内容标识办法》要求带显式与隐式标识；
  元数据字段名以 GB 45438-2025 正式文本为准，上线前须逐项核对。
- 不生成真实人物形象；背景音乐与素材来源可追溯。
`
}
