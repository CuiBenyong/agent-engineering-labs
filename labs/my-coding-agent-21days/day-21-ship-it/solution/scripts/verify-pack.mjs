#!/usr/bin/env node
/**
 * 打包验证：真打一个包、真装到一个临时前缀、真在一个陌生目录里跑两条命令。本天新增。
 *
 * 为什么非得真跑：本地开发跑的是 `tsx src/index.ts`，用的是源码；发出去的是 dist。
 * 这两条路径能有多不一样，只有装完才知道——漏搬的资产、写错的 bin 路径、
 * 忘了 shebang、files 少列一个目录，**每一条在本地都是全绿的**。
 *
 * 三条纪律：
 *   ① 装到 `--prefix <临时目录>`，**绝不碰用户的全局 npm 环境**。
 *   ② 在一个新建的空目录里跑，**cwd 与包目录毫无关系**——这正是要验的事。
 *   ③ 无论成败都把临时目录与 .tgz 清掉（finally）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const step = (ok, label) => {
  process.stdout.write(`${ok ? '✔' : '✘'} ${label}\n`)
  if (!ok) failed += 1
}

const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'mca-prefix-'))
const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'mca-workdir-'))
let tarball = null

try {
  // 1. 打包。prepack 会先跑构建，所以这一步同时验了「构建脚本能被 npm 正确触发」
  const packed = spawnSync('npm', ['pack', '--silent'], { cwd: root, encoding: 'utf8' })
  tarball = packed.stdout.trim().split('\n').pop() ?? ''
  const size = tarball ? (await fs.stat(path.join(root, tarball))).size : 0
  step(
    packed.status === 0 && tarball.endsWith('.tgz'),
    `打包：${tarball}（${(size / 1024).toFixed(0)} KB）`
  )

  // 2. 装到临时前缀。--prefix 让这次安装完全不碰用户的全局环境
  const install = spawnSync('npm', ['i', '-g', '--prefix', prefix, path.join(root, tarball)], {
    cwd: root,
    encoding: 'utf8',
  })
  const bin = path.join(prefix, 'bin', 'mca')
  const installed = await fs
    .stat(bin)
    .then(() => true)
    .catch(() => false)
  step(install.status === 0 && installed, `安装到临时前缀：${bin}`)
  if (!installed) throw new Error(install.stderr || '安装失败')

  // 3. 在一个和包毫无关系的空目录里跑 --version
  const version = spawnSync(bin, ['--version'], {
    cwd: workdir,
    encoding: 'utf8',
    env: { ...process.env, MOCK: '1' },
  })
  step(
    version.status === 0 && /^mca \d+\.\d+\.\d+/.test(version.stdout.trim()),
    `mca --version → ${version.stdout.trim()}`
  )

  // 4. 同一个陌生目录里跑一次真实任务（离线剧本，但工具是真跑的：真改文件、真跑测试）
  const task = spawnSync(bin, ['--task', '修一下失败的测试', '--yes'], {
    cwd: workdir,
    encoding: 'utf8',
    env: { ...process.env, MOCK: '1' },
  })
  const calc = await fs
    .readFile(path.join(workdir, 'work/repo/src/calc.js'), 'utf8')
    .catch(() => '')
  step(
    task.status === 0 && calc.includes("throw new Error('divide by zero')"),
    `mca --task（在 ${workdir} 里）：沙盒仓库被生成、divide 的除零保护被写进了文件`
  )

  // 5. 配置分层在装好的命令上也成立
  const config = spawnSync(bin, ['--config', '--model', 'flag-model'], {
    cwd: workdir,
    encoding: 'utf8',
    env: { ...process.env, MOCK: '1', LLM_MODEL: 'env-model' },
  })
  step(
    config.stdout.includes('flag-model') && config.stdout.includes('flag 层'),
    'mca --config：命令行参数压过环境变量，且打印了它来自哪一层'
  )
} finally {
  if (tarball) await fs.rm(path.join(root, tarball), { force: true })
  await fs.rm(prefix, { recursive: true, force: true })
  await fs.rm(workdir, { recursive: true, force: true })
  process.stdout.write('（临时前缀、临时工作目录与 .tgz 都已清掉，全局 npm 环境一个字节没动）\n')
}

process.exit(failed > 0 ? 1 : 0)
