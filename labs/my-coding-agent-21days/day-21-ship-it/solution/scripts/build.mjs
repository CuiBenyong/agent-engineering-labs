#!/usr/bin/env node
/**
 * 构建：TypeScript 编译成 JS，再把 src 下的**非 TS 资产**原样搬进 dist。本天新增。
 *
 * 第一段是标准动作。第二段才是这个脚本存在的理由：`tsc` 只认识它会编译的文件，
 * src 下那些不是 TS 的东西（要被 spawn 起来的 .mjs 子进程、模板、静态页、数据文件）
 * 它一个都不会搬。少了它们的产物在本地跑得好好的——因为本地跑的是 `tsx src/index.ts`，
 * 根本没用 dist——**只有装到别人机器上才会炸，而且报的是 MODULE_NOT_FOUND**。
 *
 * 所以第二段是**按目录遍历**的，不是一张手写的文件清单。这条区别在这门课里尤其要紧：
 * 后面每一天都会往 src 下加东西，一张手写清单必然在某一天悄悄过期，
 * 而遍历不会——新增的文件自动被带上，没有人需要记得改这个脚本。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')
const dist = path.join(root, 'dist')

await fs.rm(dist, { recursive: true, force: true })

const tsc = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' }
)
if (tsc.status !== 0) {
  process.stderr.write('tsc 编译失败，构建中止\n')
  process.exit(tsc.status ?? 1)
}

/** 把 src 下所有不是 .ts 的文件按原相对路径复制到 dist */
async function copyAssets(dir) {
  let copied = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      copied += await copyAssets(from)
      continue
    }
    if (entry.name.endsWith('.ts')) continue
    const to = path.join(dist, path.relative(src, from))
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(from, to)
    copied += 1
  }
  return copied
}

const assets = await copyAssets(src)
process.stdout.write(`构建完成：dist/ 已生成，另外搬了 ${assets} 个非 TS 资产\n`)
