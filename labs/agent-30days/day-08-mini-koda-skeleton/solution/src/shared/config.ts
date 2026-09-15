import 'dotenv/config'

export interface Config {
  port: number
  host: string
  /** true 时走内存实现：不需要 Docker、不需要 Postgres */
  mock: boolean
  databaseUrl: string | undefined
  selfTest: boolean
}

export function loadConfig(): Config {
  const mock = process.env.MOCK === '1'
  const databaseUrl = process.env.DATABASE_URL
  if (!mock && !databaseUrl) {
    throw new Error('缺少 DATABASE_URL（或用 MOCK=1 走内存实现离线运行）')
  }
  return {
    // 自检时默认监听 0：让内核随便分一个空闲端口，免得和别的服务撞车
    port: Number(process.env.PORT ?? (process.env.SELFTEST === '1' ? 0 : 3000)),
    host: process.env.HOST ?? '0.0.0.0',
    mock,
    databaseUrl,
    selfTest: process.env.SELFTEST === '1',
  }
}
