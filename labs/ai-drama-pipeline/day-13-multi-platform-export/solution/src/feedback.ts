// 数据回收：把发布后的播放数据映射回具体环节。
//
// 回流的价值不在于「看到数据」，在于每一条数据都能落到一个可以改的环节上。
// 所以这里的输出不是报表，是一组带 stage 的建议——stage 就是流水线上的节点 id。

export type RetentionPoint = { atSec: number; ratio: number }

export type PlaybackStat = {
  platform: string
  episodeId: string
  publishedAt: string
  views: number
  likes: number
  comments: number
  shares: number
  /** 完播率 0–1 */
  completionRate: number
  /** 留存曲线，按秒采样 */
  retention: RetentionPoint[]
}

export type Finding = {
  window: string
  /** 对应流水线上的节点：cover / titles / frames / clips / voice / script */
  stage: string
  symptom: string
  action: string
}

export type ShotWindow = { shotId: string; startSec: number; endSec: number }

/**
 * 三条判据，都刻意写得很笨：留存曲线的三段各对应流水线上不同的环节。
 * 笨的好处是可解释——你能对着日志说清「为什么建议改这一环」。
 */
export function diagnose(stat: PlaybackStat, windows: ShotWindow[]): Finding[] {
  const findings: Finding[] = []
  const at = (sec: number) => stat.retention.find((p) => p.atSec === sec)?.ratio ?? 1

  const openDrop = 1 - at(3)
  if (openDrop > 0.4) {
    findings.push({
      window: '0–3 秒',
      stage: 'cover+titles+frames',
      symptom: `前 3 秒掉了 ${(openDrop * 100).toFixed(0)}%，超过 40% 的警戒线`,
      action: '换封面与标题的前三名重发一版，并检查第一镜的首帧是不是没有信息量',
    })
  } else {
    findings.push({
      window: '0–3 秒',
      stage: 'cover+titles+frames',
      symptom: `前 3 秒掉了 ${(openDrop * 100).toFixed(0)}%，在警戒线内`,
      action: '保持',
    })
  }

  let worst: { drop: number; from: number; to: number } | null = null
  for (let i = 1; i < stat.retention.length; i += 1) {
    const prev = stat.retention[i - 1]
    const cur = stat.retention[i]
    if (!prev || !cur || prev.atSec < 3) continue
    const drop = prev.ratio - cur.ratio
    if (!worst || drop > worst.drop) worst = { drop, from: prev.atSec, to: cur.atSec }
  }
  if (worst && worst.drop > 0.15) {
    const shot = windows.find((w) => worst.from >= w.startSec && worst.from < w.endSec)
    findings.push({
      window: `${worst.from}–${worst.to} 秒`,
      stage: 'clips',
      symptom: `中段单次掉了 ${(worst.drop * 100).toFixed(0)}%，落在 ${shot?.shotId ?? '未知镜头'} 里`,
      action: `把 ${shot?.shotId ?? '该镜'} 的时长砍短或换运镜，重生成这一镜即可，不用重跑整集`,
    })
  }

  if (stat.completionRate < 0.3) {
    findings.push({
      window: '整集',
      stage: 'script',
      symptom: `完播率只有 ${(stat.completionRate * 100).toFixed(0)}%`,
      action: '结尾没有留钩子，回到剧本环节给下一集补一个悬念收尾',
    })
  }
  return findings
}
