import type { Store } from './infra/index'

/**
 * 用户档案。时区存 IANA 标识（Asia/Shanghai），**不存偏移量**：
 * 偏移量会随夏令时变化，存 "+08:00" 的那一刻你就把一个会变的量当常量记下来了。
 */
export type UserProfile = {
  id: string
  timeZone: string
  quietStart: string // 'HH:MM'，用户本地时间
  quietEnd: string
  dailyLimit: number
}

export type LocalParts = { date: string; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/**
 * 把一个 UTC 瞬时换算成用户本地的「日历日 + 时 + 分」。
 * JS 没有带时区的日期类型，只能借 Intl 的 formatToParts 拿到墙上时间——
 * Python 的 ZoneInfo、Java 的 ZonedDateTime、Swift 的 Calendar 都是原生支持的。
 */
export function localPartsOf(timeZone: string, at: Date): LocalParts {
  // 练习 1：按 timeZone 把这个 UTC 瞬时换算成用户本地的「日历日 + 时 + 分」。
  // 提示：用上面的 formatterFor(timeZone).formatToParts(at)，把 year/month/day/hour/minute
  //       几个 part 取出来拼成 LocalParts。注意 en-CA 的 hour12:false 在午夜会给出 24，要取模拉回 0。
  // 现在的默认实现直接读 UTC 字段——服务器在 UTC，就以为全世界都在 UTC，
  // 这是本天第一个、也是最贵的一个坑：跑起来不报错，只是给所有人半夜发消息。
  void timeZone
  return {
    date: at.toISOString().slice(0, 10),
    hour: at.getUTCHours(),
    minute: at.getUTCMinutes(),
  }
}

/** 该时区在这一瞬时的 UTC 偏移量（毫秒）。把本地墙上时间当成 UTC 反算出来。 */
function offsetMsAt(timeZone: string, at: Date): number {
  const p = localPartsOf(timeZone, at)
  const [y, m, d] = p.date.split('-').map(Number)
  return Date.UTC(y, m - 1, d, p.hour, p.minute) - Math.floor(at.getTime() / 60_000) * 60_000
}

export type Resolution = { instant: Date; kind: 'exact' | 'gap' | 'ambiguous' }

/**
 * 把「用户本地的某个日历日的 HH:MM」还原成唯一的 UTC 瞬时。
 * 夏令时切换那天有两种反常：
 *   gap       —— 这个本地时间根本不存在（春季前跳），顺延到过渡之后的对应时刻；
 *   ambiguous —— 这个本地时间出现两次（秋季回拨），取第一次。
 * 这两条裁定和 Java 的 ZonedDateTime.of、Swift 的 Calendar.date(from:) 默认行为一致。
 */
export function resolveLocal(timeZone: string, date: string, hhmm: string): Resolution {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mi] = hhmm.split(':').map(Number)
  const target = Date.UTC(y, m - 1, d, hh, mi)
  // 用前后各一天的偏移量当候选，切换日的两个偏移量都会被覆盖到
  const probes = [target - 86_400_000, target + 86_400_000]
  const candidates = [
    ...new Set(probes.map((p) => target - offsetMsAt(timeZone, new Date(p)))),
  ].sort((a, b) => a - b)
  const valid = candidates.filter((c) => {
    const p = localPartsOf(timeZone, new Date(c))
    return p.date === date && p.hour === hh && p.minute === mi
  })
  if (valid.length === 0)
    return { instant: new Date(candidates[candidates.length - 1]), kind: 'gap' }
  if (valid.length > 1) return { instant: new Date(valid[0]), kind: 'ambiguous' }
  return { instant: new Date(valid[0]), kind: 'exact' }
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * 第二道闸：现在是不是用户的安静时段。
 * 区间是左闭右开 [start, end)，并且**必须处理跨午夜**：22:00–08:00 的 start 比 end 大，
 * 朴素的 start <= now && now < end 恒为 false，于是半夜照发不误。
 */
export function isQuiet(profile: UserProfile, parts: LocalParts): boolean {
  const now = parts.hour * 60 + parts.minute
  const start = minutesOf(profile.quietStart)
  const end = minutesOf(profile.quietEnd)
  if (start === end) return false // 空区间：不设安静时段
  // 练习 2：补上跨午夜的分支。当 start 大于 end（22:00–08:00）时，
  // 「在区间内」意味着 now 落在 start 之后**或者** end 之前——注意是「或」不是「且」。
  // 下面这行是所有人第一次都会写的朴素版本，对 13:00–14:00 这种同日区间是对的，
  // 对 22:00–08:00 恒为 false，于是半夜照发不误。
  return now >= start && now < end
}

/**
 * 安静时段结束的那一个 UTC 瞬时。命中安静时段的消息推迟到这里，而不是丢弃。
 * 注意"哪一天的 quietEnd"要看当前本地时间在午夜的哪一侧：
 * 本地 23:30 要推到**次日** 08:00，本地 07:00 推到**当天** 08:00。
 */
export function quietEndsAt(profile: UserProfile, at: Date): Date | null {
  // 练习 3：算出安静时段结束的那一个 UTC 瞬时，消息推迟到这里而不是被丢弃。
  // 提示：先用 localPartsOf 拿到当前本地时间，再判断 quietEnd 属于「今天」还是「明天」——
  //       本地 23:30 要推到**次日** 08:00，本地 07:00 推到**当天** 08:00（用 addDays 加一天）。
  //       最后交给 resolveLocal 把本地墙上时间还原成唯一的 UTC 瞬时。
  // 返回 null 表示「算不出来」，passGates 只能把这条消息丢掉——这正是本天要消灭的行为。
  void addDays
  void resolveLocal
  return null
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export type GateAction = 'send' | 'defer' | 'drop'
/** localDate 是**用户本地日历日**，投递失败要按它把名额还回去，所以必须一路带出来。 */
export type GateVerdict = {
  action: GateAction
  reason: string
  localDate: string
  dueAt?: Date
}

/**
 * 三道闸，顺序固定：时区 → 安静时段 → 每日上限。
 *
 * 顺序不是随便排的：被安静时段推迟的消息不该占掉今天的名额，所以上限闸必须在最后。
 * 位置更关键——**这个函数必须在生成内容之前调用**。放到发送那一步，
 * 每一条被拦下的消息你都已经付过一次模型调用的钱了。
 */
export async function passGates(
  store: Store,
  profile: UserProfile,
  candidate: { id: string; expiresAt?: string },
  at: Date
): Promise<GateVerdict> {
  // 第一道闸：一律用 UTC 存、判断前先转成用户本地时间
  const parts = localPartsOf(profile.timeZone, at)

  // 第二道闸：安静时段。命中就推迟到窗口结束，除非这条消息在那之前就过期了
  if (isQuiet(profile, parts)) {
    const dueAt = quietEndsAt(profile, at)
    // 算不出窗口结束时刻就只能丢弃——而"丢弃"正是本天要消灭的行为
    if (!dueAt) {
      return { action: 'drop', reason: '安静时段内，但算不出窗口结束时刻', localDate: parts.date }
    }
    if (candidate.expiresAt && new Date(candidate.expiresAt) <= dueAt) {
      return {
        action: 'drop',
        reason: `安静时段内且 ${candidate.expiresAt} 前过期，丢弃`,
        localDate: parts.date,
      }
    }
    return {
      action: 'defer',
      reason: `本地 ${fmt(parts)} 在安静时段内`,
      localDate: parts.date,
      dueAt,
    }
  }

  // 第三道闸：每日上限。计数按**用户本地日历日**，不是 UTC 日
  const used = await store.bumpDaily(profile.id, parts.date)
  // 练习 4：补上上限判断。bumpDaily 已经先占了一个名额并把自增后的值返回给你，
  // 如果它超过了 profile.dailyLimit，就用 releaseDaily 把名额还回去，并返回 drop。
  // 提示：为什么要「先占坑再判断」而不是「先查后写」——并发下先查后写会一起读到 2 然后一起发。
  // 现在的默认实现只计数、不拦截，于是用户一天能收到无限多条。
  return { action: 'send', reason: `本地 ${fmt(parts)}，当天第 ${used} 条`, localDate: parts.date }
}

function fmt(parts: LocalParts): string {
  return `${parts.date} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}
