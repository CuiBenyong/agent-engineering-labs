// 两个「网络出口」函数。真实实现会在这里打第三方 API；MOCK=1 时走内置假数据表，
// 保证整个实验离线可跑。业务逻辑（校验、换算、错误分类）在 tools.ts 里，MOCK 下同样真实执行。

export interface Weather {
  celsius: number
  conditions: string
  updatedAt: string
}

const WEATHER_TABLE: Record<string, Weather> = {
  上海: { celsius: 24, conditions: '多云', updatedAt: '2026-09-06T08:00:00Z' },
  北京: { celsius: 19, conditions: '晴', updatedAt: '2026-09-06T08:00:00Z' },
  Seattle: { celsius: 15, conditions: '小雨', updatedAt: '2026-09-06T08:00:00Z' },
  Singapore: { celsius: 31, conditions: '雷阵雨', updatedAt: '2026-09-06T08:00:00Z' },
}

/** 以人民币为基准的假汇率表：1 单位该币种能换多少人民币。 */
const RATE_TABLE: Record<string, number> = {
  CNY: 1,
  USD: 7.12,
  EUR: 7.78,
  JPY: 0.048,
  SGD: 5.51,
}

export const KNOWN_CITIES = Object.keys(WEATHER_TABLE)
export const KNOWN_CURRENCIES = Object.keys(RATE_TABLE)

function offline(): boolean {
  return process.env.MOCK === '1'
}

/** 网络出口一：天气。 */
export async function fetchWeather(city: string): Promise<Weather | null> {
  if (offline()) {
    await new Promise((r) => setTimeout(r, 20)) // 假装有点网络延迟
    return WEATHER_TABLE[city] ?? null
  }
  const base = process.env.WEATHER_API_URL
  if (!base) throw new Error('缺少 WEATHER_API_URL（或用 MOCK=1 离线运行）')
  const res = await fetch(`${base}?city=${encodeURIComponent(city)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`天气服务返回 ${res.status}`)
  return (await res.json()) as Weather
}

/** 网络出口二：汇率。返回「1 单位该币种值多少人民币」。 */
export async function fetchRate(currency: string): Promise<number | null> {
  if (offline()) {
    await new Promise((r) => setTimeout(r, 20))
    return RATE_TABLE[currency] ?? null
  }
  const base = process.env.FX_API_URL
  if (!base) throw new Error('缺少 FX_API_URL（或用 MOCK=1 离线运行）')
  const res = await fetch(`${base}?symbol=${encodeURIComponent(currency)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`汇率服务返回 ${res.status}`)
  const body = (await res.json()) as { rate: number }
  return body.rate
}
