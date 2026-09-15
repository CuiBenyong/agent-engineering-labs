import 'dotenv/config'
import { startRepl } from './repl.js'
import { printSessions } from './session/open.js'
import { parseArgv } from './cli.js'
import { versionLine } from './ship/version.js'
import { helpText } from './ship/help.js'
import { boot, printConfig } from './ship/boot.js'
import { runTask } from './ship/task.js'

/**
 * 入口。来自 D16，本天改了一处：在进 REPL 之前多了四条**立刻打印然后退出**的支线
 * （--version / --help / --config / --task），并且 REPL 与 --task 都先过一遍 boot()。
 *
 * 顺序是想过的：--version 与 --help 排在最前面，而且**一个配置文件都不读**。
 * 理由是 `mca --version` 必须在什么都没配好的时候也能跑通——它常常正是用户
 * 用来确认「到底装上了没有」的那条命令，此时要求它先把配置算明白是荒唐的。
 *
 * 自检仍然是本课二十一天统一的验收入口：MOCK=1 SELFTEST=1 pnpm start
 */
if (process.env.SELFTEST === '1') {
  await import('./selftest.js')
} else {
  const options = parseArgv(process.argv.slice(2))
  const write = (line: string) => void process.stdout.write(`${line}\n`)
  if (options.version) {
    write(await versionLine())
  } else if (options.help) {
    write(helpText().join('\n'))
  } else if (options.config) {
    write((await printConfig(options)).join('\n'))
  } else if (options.sessions) {
    await printSessions()
  } else {
    const booted = await boot(options)
    for (const line of booted.lines) write(line)
    if (booted.blocking) {
      // 缺 key 在真实模式下是**跑不下去**，所以退出码非 0：
      // 让 CI 里的这次调用红掉，比让它绿着什么都没干好
      process.exitCode = 1
    } else if (options.task) {
      const outcome = await runTask({ line: options.task, yes: options.yes === true })
      process.exitCode = outcome.code
    } else {
      await startRepl(options)
    }
  }
}
