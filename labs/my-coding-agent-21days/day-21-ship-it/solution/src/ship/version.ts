/**
 * 版本号。本天新增。
 *
 * 一条纪律：**版本号只有一个真源，就是 package.json 里的那一行。**
 * 见过太多项目在代码里另写一个 `const VERSION = '0.3.1'`，发版时改了一处忘了另一处，
 * 于是 `--version` 报的和 npm 上的对不上——这种 bug 不会让任何测试变红，
 * 只会让用户提的 issue 全部报错版本。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { packageRoot } from './paths.js'

export interface PackageInfo {
  name: string
  version: string
}

let cached: PackageInfo | null = null

export async function packageInfo(): Promise<PackageInfo> {
  if (cached) return cached
  const file = path.join(packageRoot(), 'package.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<PackageInfo>
  cached = { name: raw.name ?? 'mca', version: raw.version ?? '0.0.0' }
  return cached
}

/**
 * `--version` 打印的那一行。
 *
 * 带上 Node 版本不是凑字数：这个工具对 Node 有下限要求（node --test、fetch、
 * AbortSignal.timeout），用户报「跑不起来」时，第一件要知道的事就是他用的哪个 Node。
 * 让他复制一行就把两件事都说清楚，比来回问三轮快。
 */
export async function versionLine(): Promise<string> {
  const info = await packageInfo()
  return `mca ${info.version}（包名 ${info.name}，Node ${process.version}）`
}
