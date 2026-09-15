/**
 * 回滚前的工作区检查。本天新增，也是本天最该写对的一段。
 *
 * 回滚是**唯一一个会主动覆盖用户文件的动作**。它和 edit_file 有本质区别：
 * edit_file 有 old_string 必须逐字匹配这条护栏，改不动就失败；而回滚是整文件覆写，
 * 它不会失败——它会成功地把你手写的那一段冲掉，而且没有任何提示。
 *
 * 所以覆盖之前必须回答一个问题：**磁盘上现在这些文件，是不是我记录过的样子？**
 *
 * 两条检查，一条拒绝一条警告，区别在「回滚会不会造成不可恢复的损失」：
 *
 *   内容不一致  →  **拒绝整次回滚。** 有人在 mca 之外改过这个文件，而那份内容
 *                  从没进过任何一次快照。回滚会让它永久消失，谁都恢复不了。
 *                  正确的做法是先拒绝、再告诉用户是哪几个文件、他可以怎么办。
 *   仅 mtime 更新  →  **警告并要求确认。** 文件被人碰过，但内容和记录一致
 *                  （最常见的是改了又改回来）。回滚在这种情况下是无害的，
 *                  所以不该拦住用户，但该让他知道。
 *
 * 关于 git：真实仓库里「未提交改动」通常用 git status 判定，而这门课的沙盒仓库
 * 不在 git 里（它在 work/ 下面，见 seed.ts）。所以本课把这个概念落成一条更普适的
 * 判据——**工作区里存在 mca 没有记录过的改动**。两者在真实仓库里是一回事：
 * git 的未提交改动就是「不在任何一次快照里的改动」的一个特例。
 * 真实实现应该**两条都查**：git status --porcelain 抓工具之外的编辑器改动，
 * 快照哈希抓 git 也不知道的（未跟踪文件、.gitignore 里的东西）。
 */
import fs from 'node:fs/promises'
import { hashOf } from './store.js'
import { latestState, type Checkpoint } from './log.js'
import { resolveInside } from '../tools/fs.js'

export interface Drift {
  path: string
  kind: 'content' | 'mtime' | 'missing'
  /** 给人看的一句话，要说清「所以呢」 */
  note: string
}

/**
 * 拿快照记录和磁盘对一遍。
 *
 * 只检查**记录过的文件**：mca 从没碰过的文件不在检查范围里，因为回滚也不会去动它们。
 * 这条边界很重要——把整个仓库都纳进来，读者第一次跑就会被一堆无关警告淹没，
 * 然后学会忽略警告，而那正是我们要避免的结果。
 */
export async function detectDrift(checkpoints: Checkpoint[], cwd: string): Promise<Drift[]> {
  const drifts: Drift[] = []
  for (const [relative, entry] of latestState(checkpoints)) {
    let content: string | null = null
    let mtimeMs: number | null = null
    try {
      const target = resolveInside(cwd, relative)
      content = await fs.readFile(target, 'utf8')
      mtimeMs = (await fs.stat(target)).mtimeMs
    } catch {
      content = null
    }

    if (content === null) {
      // 记录说它该存在，磁盘上没有。这也是「未记录的改动」的一种（有人删了它）
      if (entry.hash !== null) {
        drifts.push({
          path: relative,
          kind: 'missing',
          note: '记录里它该存在，但磁盘上找不到了（被删掉了？）',
        })
      }
      continue
    }

    // TODO(5)：现在**只比了修改时间**，而且一律只报 mtime 级警告（不拦）。
    // 于是「有人在 mca 之外改过这个文件、那份内容不在任何快照里」这种情况
    // 也只是一行警告，回滚照做——用户手写的那一段就永久消失了。
    // 补上内容比较：先算 hashOf(content)，与 entry.hash 不一致就报 content 级
    // （blocking 会把它当拒绝理由）；一致但 mtime 比快照更新，才报 mtime 级。
    // 顺序不能反：内容不一致时不必再看时间，那已经是最严重的一种。
    if (entry.mtimeMs !== null && mtimeMs !== null && mtimeMs > entry.mtimeMs + 1) {
      drifts.push({
        path: relative,
        kind: 'mtime',
        note: '修改时间比快照更新——这个文件被人碰过',
      })
    }
    void hashOf
  }
  return drifts
}

/** 哪些漂移会拒绝回滚（内容层面的），哪些只警告（时间层面的） */
export function blocking(drifts: Drift[]): Drift[] {
  return drifts.filter((drift) => drift.kind !== 'mtime')
}

export function formatDrift(drifts: Drift[]): string[] {
  return drifts.map(
    (drift) => `  ${drift.kind === 'mtime' ? '⚠' : '✘'} ${drift.path}：${drift.note}`
  )
}
