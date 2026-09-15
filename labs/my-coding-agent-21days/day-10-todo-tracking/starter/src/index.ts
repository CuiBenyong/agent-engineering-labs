import 'dotenv/config'
import { startRepl, printSessions } from './repl.js'
import { parseArgv } from './cli.js'

/**
 * 入口：解析参数，决定进 REPL、跑自检，还是只列一下会话。
 * 自检是本课全部二十一天统一的验收入口：MOCK=1 SELFTEST=1 pnpm start
 */
if (process.env.SELFTEST === '1') {
  await import('./selftest.js')
} else {
  const options = parseArgv(process.argv.slice(2))
  if (options.sessions) await printSessions()
  else await startRepl(options)
}
