/**
 * 今天新增的两条斜杠命令。本天新增。
 *
 * `/rewind` 的语法本身就是今天那条口径的界面化：**要回哪条线，你得说出来。**
 *
 *   /rewind                     列出两条时间线与用法（什么都不做）
 *   /rewind none <cp>           预演：打印会还原哪些文件、会截断到哪，一个字节都不动
 *   /rewind files <cp>          只回文件
 *   /rewind chat <seq>          只回对话（复用第七天的分叉）
 *   /rewind both <cp> <seq>     都回。**两个参数，因为它们是两条线上的两个位置**
 *
 * `both` 要两个参数这件事经常被抱怨「不好用」，但把它做成一个参数就要求两条线
 * 一一对应，而它们本来就不对应：一轮对话里可能改了五个文件，也可能一个都没改。
 * 强行对应的实现要么在快照里塞一个会话 seq（于是两条线绑死，只回一边就做不到了），
 * 要么按时间戳猜（于是回滚变成一件不确定的事）。**不好用胜过不确定。**
 */
import type { Command } from '../commands.js'
import { replaceHistory } from '../session-factory.js'
import { readEvents } from '../session/log.js'
import { forkPoints } from '../session/replay.js'
import { formatCheckpoints, readCheckpoints } from './log.js'
import { storeStats } from './store.js'
import { applyFiles, formatFilePlan, planFiles, rewindConversation } from './rewind.js'
import { blocking, detectDrift, formatDrift } from './workspace.js'
import { REPO_DIR } from '../seed.js'

export const SNAPSHOT_COMMANDS: Command[] = [
  {
    name: 'checkpoints',
    help: '列出文件快照的时间线，以及对象库省下了多少份',
    run: async (_args, session) => {
      const read = await readCheckpoints()
      if (read.checkpoints.length === 0) {
        session.out('  还没有任何快照（跑一轮改文件的任务就会有了）')
        return true
      }
      for (const row of formatCheckpoints(read.checkpoints)) session.out(`  ${row}`)
      const stats = await storeStats()
      const hashes = new Set(read.checkpoints.map((c) => c.hash).filter(Boolean))
      session.out(
        `  ${read.checkpoints.length} 条记录指向 ${hashes.size} 份不同内容，对象库里 ${stats.objects} 个对象、${stats.bytes} 字节`
      )
      if (read.stoppedAtLine !== null) {
        session.out(`  ⚠ 第 ${read.stoppedAtLine} 行读不下去了，已停在前一条完整记录`)
      }
      return true
    },
  },
  {
    name: 'rewind',
    help: '回退：/rewind 看两条时间线；/rewind none|files|chat|both … 见下面的用法',
    run: async (args, session) => {
      const [mode, first, second] = args.split(/\s+/).filter(Boolean)
      const force = args.includes('--force')
      const read = await readCheckpoints()
      const events = (await readEvents(session.log.id)).events

      if (!mode || mode === '--force') {
        session.out('  文件这一条线（/checkpoints 看全部）：')
        for (const row of formatCheckpoints(read.checkpoints).slice(-6)) session.out(`    ${row}`)
        session.out('  对话这一条线（只有干净的边界才能分）：')
        for (const point of forkPoints(events).slice(-6)) {
          session.out(`    seq ${point.seq}  ${point.role}: ${point.preview}`)
        }
        session.out(
          '  用法：/rewind none 12 预演 ｜ files 12 只回文件 ｜ chat 7 只回对话 ｜ both 12 7 都回'
        )
        session.out(
          '  两条线是独立的，所以 both 要两个位置——一轮对话可能改了五个文件，也可能一个都没改。'
        )
        return true
      }

      const wantFiles = mode === 'files' || mode === 'both' || mode === 'none'
      const cp = Number(first)
      if (wantFiles && !(cp > 0)) {
        session.out('  要给一个快照编号，例如 /rewind files 12（/checkpoints 看编号）')
        return true
      }
      const rows = wantFiles ? planFiles(read.checkpoints, cp) : []

      // 预演：把会发生的事全打出来，一个字节都不动。这一支存在的意义是
      // 「先看看再决定」——回滚是唯一会主动覆盖用户文件的动作，值得给它一个预演
      if (mode === 'none') {
        session.out(`  预演：回到快照 #${cp} 的话——`)
        for (const row of formatFilePlan(rows)) session.out(row)
        for (const row of formatDrift(await detectDrift(read.checkpoints, REPO_DIR))) {
          session.out(row)
        }
        session.out('  什么都没有回滚（这是 /rewind none 的全部作用）')
        return true
      }

      if (wantFiles) {
        const drifts = await detectDrift(read.checkpoints, REPO_DIR)
        for (const row of formatDrift(drifts)) session.out(row)
        const hard = blocking(drifts)
        if (hard.length > 0 && !force) {
          // 先拒绝，再提示。不许悄悄覆盖：那几个文件的内容不在任何一次快照里，
          // 冲掉之后谁都恢复不了
          session.out(`  ✘ 没有回滚任何东西：有 ${hard.length} 个文件的改动不在任何快照里。`)
          session.out('  先把它们保存或提交，或者确认真的可以丢，再加 --force 重来一次。')
          return true
        }
        const done = await applyFiles(rows, REPO_DIR)
        session.out(
          `  文件已回到 #${cp}：还原 ${done.restored.length} 个、删除 ${done.deleted.length} 个` +
            (done.missing.length > 0 ? `，⚠ ${done.missing.length} 个在对象库里找不到内容` : '')
        )
      }

      if (mode === 'chat' || mode === 'both') {
        const seq = Number(mode === 'chat' ? first : second)
        if (!forkPoints(events).some((point) => point.seq === seq)) {
          session.out(`  seq ${seq} 不是一个干净的分叉点（/rewind 不带参数看可选位置）`)
          return true
        }
        const back = await rewindConversation(session.log.id, seq)
        replaceHistory(session.messages, back.messages)
        session.log = back.log
        session.out(
          `  对话已回到 seq ${seq}：新会话 ${back.log.id}（复制了 ${back.copied} 条事件，` +
            `重建 ${back.messages.length} 条消息），母会话一个字节都没动`
        )
      }
      return true
    },
  },
]
