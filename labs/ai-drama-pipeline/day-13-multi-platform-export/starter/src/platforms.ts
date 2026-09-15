// 目标平台规格表 + 封装决策。
//
// ⚠️ 这张表最重要的一列是 sourceOfTruth，它诚实地记着「这条数字是从哪来的」：
//   official-doc      —— 平台官方开发者文档白纸黑字写着的
//   check-your-console —— 官方文档站上查不到，必须去你自己账号后台的规格页确认
// 代码里绝不把第二类当成第一类来判定：规格未知时按母版原样封装，并在清单里提醒人工核对。
// 编一个看起来很专业的数字，比留空危险得多——它会让你在上传失败时怀疑代码而不是怀疑那个数字。

export type SourceOfTruth = 'official-doc' | 'check-your-console'

export type PlatformSpec = {
  id: string
  name: string
  sourceOfTruth: SourceOfTruth
  /** 官方文档给出的边长上下限（像素），未知为 null */
  minSidePx: number | null
  maxSidePx: number | null
  /** 接受的容器，第一个是推荐值；未知为 null */
  containers: string[] | null
  /** 推荐视频编码；未知为 null */
  videoCodec: string | null
  maxFileBytes: number | null
  fpsRange: [number, number] | null
  maxDurationSec: number | null
  docUrl: string | null
  note: string
}

function unknownSpec(id: string, name: string): PlatformSpec {
  return {
    id,
    name,
    sourceOfTruth: 'check-your-console',
    minSidePx: null,
    maxSidePx: null,
    containers: null,
    videoCodec: null,
    maxFileBytes: null,
    fpsRange: null,
    maxDurationSec: null,
    docUrl: null,
    note: '时长 / 分辨率 / 码率 / 封面尺寸一律以你自己账号后台的规格页为准，本表不填数字',
  }
}

const GB = 1024 * 1024 * 1024

export const PLATFORMS: PlatformSpec[] = [
  {
    id: 'tiktok',
    name: 'TikTok',
    sourceOfTruth: 'official-doc',
    minSidePx: 360,
    maxSidePx: 4096,
    containers: ['mp4', 'webm', 'mov'],
    videoCodec: 'h264',
    maxFileBytes: 4 * GB,
    fpsRange: [23, 60],
    maxDurationSec: 600,
    docUrl: 'https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide/',
    note: '高宽最小 360px 最大 4096px；MP4 推荐，也接受 WebM / MOV；推荐 H.264；最大 4GB；帧率 23–60；开发者上传端点最长 10 分钟',
  },
  // 抖音与快手：公开文档站上抓不到规格，一律留空，由 unknownSpec 统一造。
  // 留空不是偷懒——它把不确定性从代码搬到了发布清单上，交给唯一能确认它的人。
  unknownSpec('douyin', '抖音'),
  unknownSpec('kuaishou', '快手'),
]

export type Packaging = {
  action: 'copy' | 'reencode'
  /** 每条判定的依据，打印出来读者才知道结论是怎么来的 */
  checks: string[]
  extraArgs: string[]
  manualChecks: string[]
}

/**
 * 决定这个平台该怎么出片：能流复制就流复制，只有母版真的不满足硬性规格时才重编码。
 * 「少转一次码」不是省时间的小聪明，是画质不再衰减一次。
 */
export function decidePackaging(
  master: {
    width: number
    height: number
    fps: number
    durationSec: number
    videoCodec: string
    container: string
    bytes: number
  },
  spec: PlatformSpec
): Packaging {
  // 练习 1：把「一律重编码」改成真正的规格判定。
  //   ① sourceOfTruth 是 check-your-console 的平台：规格未知，一律流复制，
  //      并往 manualChecks 里塞一条「上传前去后台核对」，不许猜数字。
  //   ② 官方文档有背书的平台：逐项比对分辨率、编码、帧率、文件大小，
  //      任何一项不满足才 needsReencode = true；
  //      超时长是个例外——用 -t 走流复制截断就行，不要因为它去重编码。
  //   每条判定都往 checks 里写一句人话，读者才知道结论怎么来的。
  // 现在恒定重编码：日志会打印「重编码 3 次」，母版每转一次画质就掉一次——这就是没做完的现象。
  const checks: string[] = ['（练习 1 未完成）没有做规格判定，一律重编码']
  const manualChecks: string[] = []
  const extraArgs: string[] = []
  void master
  void spec
  void GB
  return { action: 'reencode', checks, extraArgs, manualChecks }
}
