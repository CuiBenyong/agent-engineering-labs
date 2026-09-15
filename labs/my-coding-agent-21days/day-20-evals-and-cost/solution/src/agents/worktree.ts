/**
 * 工作树：给每个子 Agent 一间独立工位。本天新增。
 *
 * **先把话说清楚：这里是真实 git worktree 的简化版。** 本课的沙盒仓库 work/repo
 * 不在 git 里（seed.ts 是冻结文件，全课不改），所以没有 git 对象库可用，
 * 这个文件用的是「复制一份目录 + 记下派单那一刻的内容」。
 *
 * 真实实现该怎么做，一条都不省：
 *
 *   git worktree add --detach ../.mca/agents/<id> HEAD   # 开一间工位
 *   ...子 Agent 在那个目录里干活...
 *   git -C ../.mca/agents/<id> diff HEAD                 # 收它的产物
 *   git worktree remove --force ../.mca/agents/<id>      # 收摊
 *
 * 真实 worktree 比复制强在三点，正文里也会讲：
 *   1. **共享同一个对象库**，所以开一间工位是常数级开销，不随仓库大小线性增长；
 *   2. 每间工位有自己的 HEAD 与索引，子 Agent 可以正常 commit、stash、切分支；
 *   3. 合并与冲突判定可以直接交给 git（三方合并），不用像下面这样自己写。
 *
 * 简化版与真实版**共享同一套语义**：派单时拍下基线、干活只在自己那间屋里、
 * 回收时拿「基线 → 现在」的差异。所以正文讲的那套冲突规则换成真 git 一样成立。
 *
 * 简化版做不到的事也要说明白：它不认识重命名（真 git 的三方合并认）、
 * 不处理二进制文件、也不保留文件权限位。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { walkFiles } from '../tools/fs.js'
import { REPO_DIR } from '../seed.js'
import type { FileChange } from './spec.js'

/** 所有工位都开在这里。它在 work/ 下，所以随时可以整个删掉 */
export const AGENTS_DIR = path.resolve(process.cwd(), 'work/agents')

export interface Worktree {
  id: string
  dir: string
  /** 派单那一刻的内容快照：相对路径 → 全文。合并时的「基线」就是它 */
  base: Map<string, string>
}

/** 读一棵目录树的全部文本内容。walkFiles 已经帮我们跳过 node_modules / .git / work */
export async function readTree(dir: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>()
  for (const relative of await walkFiles(dir)) {
    tree.set(relative, await fs.readFile(path.join(dir, relative), 'utf8'))
  }
  return tree
}

/**
 * 开一间工位：把主工作区的当前内容复制过去，并记下这一刻的基线。
 *
 * **基线必须在这里取，不能等回收时再拿主工作区去比。** 子 Agent 干活的这几秒里
 * 主工作区可能被别人动过（另一个子 Agent、用户手里的编辑器），拿一个已经变了的
 * 现场当基线，算出来的差异里会混进不是它改的东西。
 */
export async function createWorktree(id: string, from = REPO_DIR): Promise<Worktree> {
  const dir = path.join(AGENTS_DIR, id)
  await fs.rm(dir, { recursive: true, force: true })
  const base = await readTree(from)
  for (const [relative, content] of base) {
    const target = path.join(dir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  return { id, dir, base }
}

/**
 * 收产物：把工位里现在的样子和基线比一遍。
 *
 * 删除**不计入**改动，这是本实现的一条明确取舍：子 Agent 删文件的破坏力
 * 远大于它改文件，而合并一个删除需要的判断（另一边是不是正好在改它）
 * 比本课想讲的那点冲突规则复杂得多。真实实现里这一条要单独设计。
 */
export async function collectChanges(tree: Worktree): Promise<FileChange[]> {
  const now = await readTree(tree.dir)
  const changes: FileChange[] = []
  for (const [relative, after] of now) {
    const before = tree.base.get(relative) ?? null
    if (before === after) continue
    changes.push({ path: relative, before, after })
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 收摊。一个子 Agent 结束之后它那间工位就没用了，留着只会让下一次跑看见脏数据。
 *
 * 那行前置判断不是多余的：**这是一次由参数拼出来的路径上的递归删除**，
 * 而 tree.dir 一路上经过了工位号、环境、以及将来可能出现的「自定义工位目录」。
 * 删之前确认它确实落在 AGENTS_DIR 里面，代价是一行，漏掉的代价是删掉别人的仓库。
 */
export async function removeWorktree(tree: Worktree): Promise<void> {
  if (!tree.dir.startsWith(AGENTS_DIR + path.sep)) return
  await fs.rm(tree.dir, { recursive: true, force: true })
}

/** 还剩几间工位没收。自检用它证明我们真的收了摊 */
export async function listWorktrees(): Promise<string[]> {
  try {
    const entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}
