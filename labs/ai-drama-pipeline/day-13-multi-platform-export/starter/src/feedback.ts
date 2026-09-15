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
  // 练习 4：把留存曲线映射回流水线上的环节。三条判据：
  //   ① 0–3 秒掉幅超过 40% → stage 'cover+titles+frames'（封面标题没抓住人）
  //   ② 3 秒之后单次相邻采样掉幅超过 15% → 用 windows 找出这一段落在哪一镜 → stage 'clips'
  //   ③ 完播率低于 0.3 → stage 'script'（结尾没留钩子）
  //   每条 Finding 都要带 window / stage / symptom / action，action 必须是能直接去改的动作。
  // 现在返回空数组：两个平台的数据长得完全不同，诊断却一条都出不来——这就是没做完的现象。
  void stat
  void windows
  return []
}
