/**
 * 开一条会话，或者接上一条；以及 --sessions 那条只列不跑的支线。
 * 本天从 repl.ts 拆出来——它到了 360 行，本课单文件上限 350。
 *
 * 拆的界线：repl.ts 管**按键与命令分发**，这个文件管**会话从磁盘上怎么回来**。
 */
import type { CliOptions } from '../cli.js'
import { SessionLog, latestSessionId, listSessions } from './log.js'
import { replay } from './replay.js'
import { newSession, replaceHistory, type Session, type SessionDeps } from '../session-factory.js'

/** --sessions：只列一下就退出 */
export async function printSessions(): Promise<void> {
  const all = await listSessions()
  if (all.length === 0) {
    process.stdout.write('还没有任何会话（跑一轮对话就会有了）\n')
    return
  }
  for (const info of all) {
    const broken = info.broken ? '（最后一行不完整）' : ''
    process.stdout.write(`${info.id}  ${info.events} 条事件  ${info.updatedAt}${broken}\n`)
  }
}

/**
 * 开一条会话，或者接上一条。返回的 note 是给用户看的一句话——
 * 恢复这件事一定要说清楚「接的是哪条、恢复了多少」，否则用户分不清
 * 「它记得」和「它在瞎猜」。
 */
export async function openSession(
  out: (line: string) => void,
  options: CliOptions,
  deps: SessionDeps = {}
): Promise<Session> {
  if (!options.resume) return newSession(out, await SessionLog.create(), deps)

  const id = options.resume === true ? await latestSessionId() : options.resume
  if (!id) {
    out('没有可恢复的会话，开一条新的。')
    return newSession(out, await SessionLog.create(), deps)
  }

  const { log, read } = await SessionLog.open(id)
  const restored = replay(read.events)
  const session = newSession(out, log, deps)
  if (restored.messages.length > 0) replaceHistory(session.messages, restored.messages)
  out(
    `已恢复会话 ${id}：重放 ${restored.replayed} 条消息事件` +
      `（另有 ${restored.skipped} 条只用于展示与审计），累计 ${restored.tokens} token。`
  )
  if (read.stoppedAtLine !== null) {
    out(`⚠ 日志第 ${read.stoppedAtLine} 行读不下去了：${read.reason}。已停在前一条完整事件。`)
  }
  if (restored.forkedFrom) {
    out(
      `（这条会话是从 ${restored.forkedFrom.from} 的第 ${restored.forkedFrom.atSeq} 条分叉出来的）`
    )
  }
  return session
}
