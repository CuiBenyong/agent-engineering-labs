import 'dotenv/config'
import { startRepl } from './repl.js'

/**
 * 入口只做一件事：决定进 REPL 还是跑自检。
 * 自检是本课全部二十一天统一的验收入口：MOCK=1 SELFTEST=1 pnpm start
 */
if (process.env.SELFTEST === '1') {
  await import('./selftest.js')
} else {
  await startRepl()
}
