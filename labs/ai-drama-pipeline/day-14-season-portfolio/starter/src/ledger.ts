// 整季账单：耗时、花费、失败率、人工介入次数。四个数字凑齐了才叫复盘。
//
// 花费同样是估算：MOCK 下 provider 返回的 costCny 恒为 0，这里按单价乘 units 算。
//
// ⚠️ 三档单价的可信度不一样，别混着用：
//   图像 ¥0.025/张 —— 官方直接标价，可以当真
//   视频按秒        —— 按量付费页给的是 768P / 2K / 480P 三个**档位**的按秒单价，
//                     而本课用的视频接口在官方是走视频点数扣减的，没有公开按秒单价。
//                     所以这一行是**台账演示用的折算常量**，不挂到任何具体模型 id 上。
//   语音按字符      —— 官方只公开资源包价，这是折算值

export const RATE = {
  imagePerItem: 0.025,
  /** 按量付费页 768P 档位的按秒单价；本课用的视频接口走点数计价，这里是折算演示常量 */
  videoPerSecond: 0.5,
  /** 折算值：按 HD 资源包摊到每字符，约每万字符三元多 */
  ttsPerCharacterApprox: 0.00035,
}

export type EpisodeRecord = {
  n: number
  title: string
  ms: number
  images: number
  videoSeconds: number
  ttsCharacters: number
  /** 真实发生的调用次数，含失败重试 */
  attempts: number
  failures: number
  /** 人工介入次数：审核台上改过台词、点过重生成都算 */
  manualTouches: number
  estimatedCny: number
}

export function estimateEpisode(r: Omit<EpisodeRecord, 'estimatedCny'>): number {
  // 练习 3：按公开单价把这一集的花费估出来。
  //   图像张数 × RATE.imagePerItem + 视频秒数 × RATE.videoPerSecond
  //   + 语音计费字符 × RATE.ttsPerCharacterApprox，保留 4 位小数。
  //   注意语音那一档是资源包折算值，不是官方标价——面板与文档里都要标出来。
  // 现在返回 0：整季账单每一集都是 ¥0.0000，看不出钱花在哪——这就是没做完的现象。
  void r
  void RATE
  return 0
}

export type SeasonSummary = {
  episodes: number
  totalMs: number
  totalCny: number
  attempts: number
  failures: number
  failureRate: number
  manualTouches: number
  perEpisodeCny: number
}

export function summarize(records: EpisodeRecord[]): SeasonSummary {
  const attempts = records.reduce((s, r) => s + r.attempts, 0)
  const failures = records.reduce((s, r) => s + r.failures, 0)
  const totalCny = Number(records.reduce((s, r) => s + r.estimatedCny, 0).toFixed(4))
  return {
    episodes: records.length,
    totalMs: records.reduce((s, r) => s + r.ms, 0),
    totalCny,
    attempts,
    failures,
    failureRate: attempts === 0 ? 0 : Number((failures / attempts).toFixed(4)),
    manualTouches: records.reduce((s, r) => s + r.manualTouches, 0),
    perEpisodeCny: records.length === 0 ? 0 : Number((totalCny / records.length).toFixed(4)),
  }
}

export function printSeasonLedger(records: EpisodeRecord[], s: SeasonSummary): void {
  console.log('\n── 整季账单 ──')
  console.log('   集  标题        耗时      图  视频秒  语音字  调用  失败  人工  花费(估算)')
  for (const r of records) {
    console.log(
      `   E${r.n}  ${r.title.padEnd(8)} ${String(r.ms).padStart(6)}ms  ${String(r.images).padStart(2)}  ` +
        `${String(r.videoSeconds).padStart(6)}  ${String(r.ttsCharacters).padStart(6)}  ` +
        `${String(r.attempts).padStart(4)}  ${String(r.failures).padStart(4)}  ${String(r.manualTouches).padStart(4)}  ¥${r.estimatedCny.toFixed(4)}`
    )
  }
  console.log(
    `   合计 ${s.episodes} 集，${(s.totalMs / 1000).toFixed(1)} 秒，调用 ${s.attempts} 次，` +
      `失败 ${s.failures} 次（失败率 ${(s.failureRate * 100).toFixed(1)}%），人工介入 ${s.manualTouches} 次`
  )
  console.log(`   花费（估算）¥${s.totalCny.toFixed(4)}，单集 ¥${s.perEpisodeCny.toFixed(4)}`)
  console.log(
    '   提示：MOCK 下没有真实调用，金额由 units 乘公开单价估算得出，语音单价是资源包折算值。'
  )
}
