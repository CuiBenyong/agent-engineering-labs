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
  const checks: string[] = []
  const manualChecks: string[] = []
  const extraArgs: string[] = []
  let needsReencode = false

  if (spec.sourceOfTruth === 'check-your-console') {
    checks.push('规格未知：按母版原样流复制，不猜数字')
    manualChecks.push(`${spec.name}：上传前对照账号后台规格页核对时长 / 分辨率 / 码率 / 封面尺寸`)
    return { action: 'copy', checks, extraArgs, manualChecks }
  }

  const long = Math.max(master.width, master.height)
  const short = Math.min(master.width, master.height)
  if (spec.minSidePx !== null && short < spec.minSidePx) {
    checks.push(`短边 ${short} 小于下限 ${spec.minSidePx}，必须放大 → 重编码`)
    needsReencode = true
  } else if (spec.maxSidePx !== null && long > spec.maxSidePx) {
    checks.push(`长边 ${long} 超过上限 ${spec.maxSidePx}，必须缩放 → 重编码`)
    needsReencode = true
  } else {
    checks.push(
      `分辨率 ${master.width}x${master.height} 落在 ${spec.minSidePx}–${spec.maxSidePx} 之间，不用动`
    )
  }

  if (spec.videoCodec && master.videoCodec !== spec.videoCodec) {
    checks.push(`编码 ${master.videoCodec} 不是推荐的 ${spec.videoCodec} → 重编码`)
    needsReencode = true
  } else {
    checks.push(`编码 ${master.videoCodec} 就是推荐值，不用动`)
  }

  if (spec.fpsRange && (master.fps < spec.fpsRange[0] || master.fps > spec.fpsRange[1])) {
    checks.push(`帧率 ${master.fps} 不在 ${spec.fpsRange[0]}–${spec.fpsRange[1]} 之间 → 重编码`)
    needsReencode = true
  } else if (spec.fpsRange) {
    checks.push(`帧率 ${master.fps} 在 ${spec.fpsRange[0]}–${spec.fpsRange[1]} 之间，不用动`)
  }

  if (spec.maxDurationSec !== null && master.durationSec > spec.maxDurationSec) {
    // 超时长可以靠流复制直接切，不需要重编码——这是最容易被写成重编码的一处。
    checks.push(
      `时长 ${master.durationSec.toFixed(1)} 秒超过 ${spec.maxDurationSec} 秒，用 -t 流复制截断，仍不重编码`
    )
    extraArgs.push('-t', String(spec.maxDurationSec))
  } else if (spec.maxDurationSec !== null) {
    checks.push(`时长 ${master.durationSec.toFixed(1)} 秒在 ${spec.maxDurationSec} 秒以内`)
  }

  if (spec.maxFileBytes !== null && master.bytes > spec.maxFileBytes) {
    checks.push(
      `文件 ${(master.bytes / GB).toFixed(2)}GB 超过 ${(spec.maxFileBytes / GB).toFixed(0)}GB，必须降码率 → 重编码`
    )
    needsReencode = true
  } else if (spec.maxFileBytes !== null) {
    checks.push(
      `文件 ${(master.bytes / 1024 / 1024).toFixed(1)}MB 远小于 ${(spec.maxFileBytes / GB).toFixed(0)}GB 上限`
    )
  }

  if (spec.containers && !spec.containers.includes(master.container)) {
    checks.push(
      `容器 ${master.container} 不在接受列表 ${spec.containers.join(' / ')} 里 → 换封装（仍可流复制）`
    )
  }

  return { action: needsReencode ? 'reencode' : 'copy', checks, extraArgs, manualChecks }
}
