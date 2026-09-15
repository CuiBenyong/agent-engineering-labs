/**
 * 回退。本天新增，也是本天的题眼所在。
 *
 * **文件的时间线与对话的时间线是两条独立的线，回滚谁是两个独立的选择。**
 *
 * 这不是为了灵活而灵活，四种组合各有各的真实用途：
 *
 *   只回文件      它改错了，但那段排查过程有用——留着对话，让它接着上文重试
 *   只回对话      文件改对了，但对话已经跑偏（绕了十轮弯路）——留着成果，把话头拉回去
 *   都回          这条路整个走错了，从岔路口重新开始
 *   都不回        先看一眼「如果回滚会发生什么」，再决定。这一支不是空操作，
 *                 它是**预演**：打印会被还原的文件与会被截断的对话，什么都不动
 *
 * 只有一种做法能同时支持这四种，就是两条线本来就没有互相引用。所以第七天定会话日志、
 * 今天定快照日志时，两边都只记自己那件事：会话日志记「说过什么」，快照日志记
 * 「文件是什么」。**如果当初在快照里塞一个 sessionSeq 字段把两者绑起来，
 * 今天这四种组合里就有两种做不出来。**
 *
 * 对话那一边完全复用第七天的分叉：复制到新文件、截断到某个 seq、记一条 fork 事件
 * 留住血缘。今天一行新的日志代码都没写——**回退对话就是分叉，只是动机不同。**
 */
import fs from 'node:fs/promises'
import { getBlob } from './store.js'
import { latestState, stateAt, type Checkpoint } from './log.js'
import { resolveInside } from '../tools/fs.js'
import { forkSession, readEvents, type SessionLog } from '../session/log.js'
import { replay } from '../session/replay.js'
import type { Message } from '../kernel/types.js'

export interface FilePlanRow {
  path: string
  /** 现在是哪个哈希（null 表示现在不存在） */
  from: string | null
  /** 回到那一刻该是哪个哈希（null 表示那一刻不存在，所以要删掉） */
  to: string | null
  action: 'restore' | 'delete' | 'unchanged'
}

/**
 * 算出「回到第 seq 条快照」要对每个文件做什么。纯函数，不碰磁盘。
 *
 * 三种动作里 delete 最容易被漏掉：任务里新建的文件，回到新建之前就该消失。
 * 只做「还原内容」的回滚会留下一堆凭空多出来的文件，而那种残留最难查——
 * 它看起来像是你自己建的。
 */
export function planFiles(checkpoints: Checkpoint[], seq: number): FilePlanRow[] {
  const target = stateAt(checkpoints, seq)
  const rows: FilePlanRow[] = []
  for (const [path, current] of latestState(checkpoints)) {
    const want = target.get(path)
    const to = want ? want.hash : null
    if (to === current.hash) {
      rows.push({ path, from: current.hash, to, action: 'unchanged' })
      continue
    }
    rows.push({ path, from: current.hash, to, action: to === null ? 'delete' : 'restore' })
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : 1))
}

export interface FileRewindResult {
  restored: string[]
  deleted: string[]
  /** 对象库里找不到内容的文件。理论上不该发生，真发生了必须报出来而不是静默跳过 */
  missing: string[]
}

export async function applyFiles(rows: FilePlanRow[], cwd: string): Promise<FileRewindResult> {
  const result: FileRewindResult = { restored: [], deleted: [], missing: [] }
  for (const row of rows) {
    const target = resolveInside(cwd, row.path)
    if (row.action === 'delete') {
      await fs.rm(target, { force: true })
      result.deleted.push(row.path)
      continue
    }
    if (row.action !== 'restore' || row.to === null) continue
    const content = await getBlob(row.to)
    if (content === null) {
      result.missing.push(row.path)
      continue
    }
    await fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    result.restored.push(row.path)
  }
  return result
}

export interface ConversationRewind {
  log: SessionLog
  messages: Message[]
  copied: number
  /** 血缘：从哪条会话的第几条分出来的。它来自第七天那条 fork 事件 */
  forkedFrom: { from: string; atSeq: number } | null
}

/** 回退对话 = 第七天的分叉。复制到新文件，母会话一个字节都不动 */
export async function rewindConversation(
  sessionId: string,
  atSeq: number
): Promise<ConversationRewind> {
  const { log, copied } = await forkSession(sessionId, atSeq)
  const restored = replay((await readEvents(log.id)).events)
  return { log, messages: restored.messages, copied, forkedFrom: restored.forkedFrom }
}

export function formatFilePlan(rows: FilePlanRow[]): string[] {
  const acting = rows.filter((row) => row.action !== 'unchanged')
  if (acting.length === 0) return ['  文件这一边没有需要还原的东西']
  return acting.map((row) =>
    row.action === 'delete'
      ? `  ✗ ${row.path}  删掉（那一刻它还不存在）`
      : `  ← ${row.path}  ${row.from ?? '不存在'} → ${row.to}`
  )
}
