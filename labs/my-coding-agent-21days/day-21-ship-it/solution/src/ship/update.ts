/**
 * 版本检查。本天新增。
 *
 * 这个功能的全部难点都不在「怎么查」，在**怎么不烦人、怎么不添乱**。
 * 一个做坏了的更新检查能干出三件事：启动多等两秒、离线时报一行红字、
 * registry 抽风时整个工具起不来。这三件事都比「用户晚一周升级」严重得多。
 *
 * 所以四条硬规矩：
 *   ① 失败一律静默。任何异常、超时、解析失败都当作「这次没查到」。
 *   ② 有超时。没有超时的网络请求等于把别人的可用性接到自己的启动路径上。
 *   ③ 有节流。一天查一次就够了，结果缓存在用户目录。
 *   ④ 离线模式不查。MOCK=1 的语义是「不发任何网络请求」，这条不能有例外。
 *
 * 取数的动作用参数注入（fetchLatest），所以自检可以喂一个「必然抛错」的和一个
 * 「返回新版本」的，**一次网络都不用真发**。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { userConfigDir } from './paths.js'

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateOptions {
  current: string
  /** 注入的取数动作。默认实现见 fetchLatestFromRegistry */
  fetchLatest?: () => Promise<string | null>
  now?: number
  cacheFile?: string
  /** MOCK=1 或用户显式关掉时传 true */
  disabled?: boolean
}

export interface UpdateResult {
  latest: string | null
  /** 有没有真的去查。节流命中或被禁用时是 false */
  checked: boolean
  /** 要打给用户看的那一行；没有新版本就是 null */
  notice: string | null
}

interface Cache {
  at: number
  latest: string | null
}

/** 只比 x.y.z 三段数字，够用且不会引 semver 包。看不懂的版本串一律当作「不比当前新」 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ''))
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(latest)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] as number) > (b[i] as number)) return true
    if ((a[i] as number) < (b[i] as number)) return false
  }
  return false
}

/** 默认取数：问一次 npm registry。**它自己一个异常都不往外抛** */
export async function fetchLatestFromRegistry(name: string): Promise<string | null> {
  try {
    const registry = process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org'
    const response = await fetch(`${registry.replace(/\/+$/, '')}/${name}/latest`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

export async function checkUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const now = options.now ?? Date.now()
  const cacheFile = options.cacheFile ?? path.join(userConfigDir(), 'update-check.json')
  const none: UpdateResult = { latest: null, checked: false, notice: null }
  if (options.disabled) return none

  let cache: Cache | null = null
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as Cache
  } catch {
    cache = null
  }
  // 节流：缓存还新鲜就直接用它的结论，一次网络都不发
  if (cache && now - cache.at < CHECK_INTERVAL_MS) {
    return {
      latest: cache.latest,
      checked: false,
      notice: noticeFor(cache.latest, options.current),
    }
  }

  let latest: string | null = null
  try {
    latest = (await options.fetchLatest?.()) ?? null
  } catch {
    // ① 失败一律静默。注意这里连 latest 都不改成某个哨兵值——
    // 「这次没查到」和「查到了没有新版」在用户看来是同一件事：屏幕上什么都不多
    latest = null
  }
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true })
    await fs.writeFile(cacheFile, JSON.stringify({ at: now, latest } satisfies Cache), 'utf8')
  } catch {
    // 写不了缓存也不是错误：最坏的后果是下次启动再查一遍
  }
  return { latest, checked: true, notice: noticeFor(latest, options.current) }
}

function noticeFor(latest: string | null, current: string): string | null {
  if (!latest || !isNewer(latest, current)) return null
  // 一行，不带感叹号，不挡路。更新提示是一句告知，不是一次打断
  return `（有新版本 ${latest}，当前 ${current}；npm i -g mca 升级）`
}
