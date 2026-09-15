/**
 * 三层指令文件的发现。本天新增。
 *
 * 三层各自的作用域，顺序就是「越具体越靠后」：
 *
 *   用户级   $MCA_HOME/AGENTS.md          我这个人的偏好，所有仓库都生效
 *   项目级   <仓库根>/AGENTS.md            这个仓库的规矩，进仓库的人都该遵守
 *   目录级   <启动目录及其上溯>/AGENTS.md   这一片代码的特殊规矩
 *
 * 三条口径：
 *
 * 一、**用户主目录用环境变量模拟，绝不读写真实的 ~。** 一个练习用的 lab 往用户主目录里
 *    写文件是不可接受的，而且真实主目录里可能已经有别的工具的同名文件。
 *    生产实现里这里换成 os.homedir() 就行，发现逻辑一个字都不用改。
 *
 * 二、**仓库根靠标记文件往上找，不靠「往上三层」这种猜测。** 标记是 .git 或 package.json，
 *    找到第一个就停。找不到就把启动目录当成根——这比一路上溯到文件系统根安全得多，
 *    否则用户在 /tmp 里跑一次，你会去读 /AGENTS.md。
 *
 * 三、**按 realpath 去重。** 同一个文件可能通过软链接被发现两次（很常见：把项目级指令
 *    软链到子目录）。不去重的话它会在 system prompt 里出现两遍，既花钱又让模型
 *    在两份「同样权威」的副本之间无所适从。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 指令文件的固定名字。它该不该可配置是 D21 的题目，今天写死 */
export const INSTRUCTION_FILE = 'AGENTS.md'

/** 仓库根的标记。顺序无关，命中任何一个就算根 */
const ROOT_MARKERS = ['.git', 'package.json']

export type Layer = 'user' | 'project' | 'directory'

export interface Found {
  layer: Layer
  /** 绝对路径，读文件用它 */
  path: string
  /** 显示给用户的名字，尽量是相对当前工作目录的短路径 */
  label: string
}

export interface DiscoverOptions {
  /** 模拟的用户主目录 */
  home: string
  /** 「当前目录」：mca 被启动的那个目录 */
  start: string
}

export const LAYER_NAMES: Record<Layer, string> = {
  user: '用户级',
  project: '项目级',
  directory: '目录级',
}

/** 从 start 往上找仓库根；找不到就返回 start 自己 */
export async function findRepoRoot(start: string): Promise<string> {
  let dir = path.resolve(start)
  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (await exists(path.join(dir, marker))) return dir
    }
    const parent = path.dirname(dir)
    // 到文件系统根就停：没有标记的情况下不许把 / 当成仓库根
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

/**
 * 找出全部三层，按「越具体越靠后」的顺序返回。
 *
 * 目录级那一段是从仓库根往下逐级看到启动目录，所以外层在前、内层在后——
 * 这个顺序就是后面合并时的优先级，**发现阶段把顺序排好，合并阶段就不必再排一次**。
 */
export async function discover(options: DiscoverOptions): Promise<Found[]> {
  const found: Found[] = []
  const seen = new Set<string>()

  const push = async (layer: Layer, file: string): Promise<void> => {
    if (!(await exists(file))) return
    // 软链接去重：同一个文件被两条路径发现时只算一次
    const real = await fs.realpath(file).catch(() => file)
    if (seen.has(real)) return
    seen.add(real)
    found.push({ layer, path: file, label: display(file) })
  }

  await push('user', path.join(options.home, INSTRUCTION_FILE))

  const root = await findRepoRoot(options.start)
  await push('project', path.join(root, INSTRUCTION_FILE))

  // 从仓库根往下走到启动目录，外层在前
  const start = path.resolve(options.start)
  const relative = path.relative(root, start)
  let dir = root
  for (const part of relative ? relative.split(path.sep) : []) {
    dir = path.join(dir, part)
    await push('directory', path.join(dir, INSTRUCTION_FILE))
  }
  return found
}

function display(file: string): string {
  const relative = path.relative(process.cwd(), file)
  return relative.startsWith('..') ? file : relative.split(path.sep).join('/')
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}
