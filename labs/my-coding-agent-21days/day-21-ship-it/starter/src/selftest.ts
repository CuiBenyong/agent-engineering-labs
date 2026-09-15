/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十四件事，打印勾叉后按结果退出。
 *
 * 今天的断言分两类，都离线、都可复现：
 *   一类是**产物级**的——真的跑一次构建、真的问一次 npm 打包清单，
 *     然后核对「src 下有的东西，dist 与包里有没有」。这一类必须真跑，
 *     因为打包最典型的故障是「本地好好的，装到别人机器上少了个文件」，
 *     而那种故障在本地跑 tsx 源码时**永远不会出现**。
 *   一类是**纯函数级**的——配置分层谁盖谁、密钥被拒、更新检查失败静默、
 *     非交互下审批默认拒绝。它们注入假的取数动作与临时目录，一次网络都不发。
 *
 * 全局安装那一段不在这里：它要几十秒、要装依赖、还要落到临时前缀上，
 * 放进每次验收的自检里是不合适的。它是一条独立脚本：pnpm verify:pack。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stdout } from 'node:process'
import { loadShipConfig, maskKey, formatConfig, applyShipConfig } from './ship/config-layers.js'
import { diagnose } from './ship/doctor.js'
import { checkUpdate, isNewer, CHECK_INTERVAL_MS } from './ship/update.js'
import { packageInfo, versionLine } from './ship/version.js'
import { packageRoot } from './ship/paths.js'
import { parseArgv } from './cli.js'
import { runTask } from './ship/task.js'
import { seedRepo, REPO_DIR } from './seed.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0
/** 分层配置那几项摆在临时目录里。提到模块级，是为了让清理能写进文件末尾的 finally */
let tempHome = ''

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const ROOT = packageRoot(path.dirname(fileURLToPath(import.meta.url)))

interface PackFile {
  path: string
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    version: string
    bin?: Record<string, string>
    files?: string[]
  }

  // 1. 版本号只有一个真源
  const info = await packageInfo()
  const line = await versionLine()
  check(
    info.version === pkg.version &&
      line.startsWith(`mca ${pkg.version}`) &&
      line.includes(process.version),
    `版本号：--version 打印「${line}」，和 package.json 的 ${pkg.version} 同源`
  )

  // 2. bin 入口：存在、有 shebang、package.json 指得对
  const binTarget = pkg.bin?.mca ?? ''
  const binText = await fs.readFile(path.join(ROOT, binTarget), 'utf8').catch(() => '')
  check(
    binTarget === 'bin/mca.mjs' &&
      binText.startsWith('#!/usr/bin/env node') &&
      binText.includes('../dist/index.js'),
    `bin 入口：${binTarget} 存在、第一行是 shebang、只做一件事（import dist）`
  )

  // 3. files 字段必须**按目录**枚举。这一条是给后面加功能的人上的保险：
  //    逐个文件列的清单会在某一天悄悄过期，而没有任何东西会报错
  const files = pkg.files ?? []
  const perFile = files.filter((entry) => /\.(ts|js|mjs)$/.test(entry))
  check(
    files.includes('dist') &&
      files.includes('bin') &&
      files.includes('skills') &&
      perFile.length === 0,
    `files 按目录枚举：${files.join('、')}——没有逐个列源码文件（列了就会漏掉后加的）`
  )

  // 4. 构建产物对账：src 下每个 .ts 在 dist 有对应的 .js，非 TS 资产原样搬过去
  const build = spawnSync('node', ['scripts/build.mjs'], { cwd: ROOT, encoding: 'utf8' })
  const srcFiles = await walk(path.join(ROOT, 'src'))
  const distFiles = new Set(await walk(path.join(ROOT, 'dist')))
  const missing = srcFiles.filter(
    (rel) => !distFiles.has(rel.endsWith('.ts') ? rel.replace(/\.ts$/, '.js') : rel)
  )
  // 两个非 TS 资产都要点名：notes-stdio.mjs 来自 D15，worker.mjs 来自 D18。
  // 它们是「按目录搬」这条设计的证人——没有人为了 worker.mjs 改过 build.mjs 一个字
  const assets = ['servers/notes-stdio.mjs', 'tasks/worker.mjs']
  check(
    build.status === 0 && missing.length === 0 && assets.every((rel) => distFiles.has(rel)),
    `构建对账：src 下 ${srcFiles.length} 个文件在 dist 里一个不少（含非 TS 的 ${assets.join(' 与 ')}）`
  )

  // 5. 打包清单：dist 与 bin 真的进了包，而 src 与 .env 真的没进
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--silent'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const manifest = (JSON.parse(packed.stdout || '[{}]') as Array<{ files?: PackFile[] }>)[0]
  const inPack = (manifest?.files ?? []).map((f) => f.path)
  check(
    inPack.includes('dist/index.js') &&
      inPack.includes('bin/mca.mjs') &&
      inPack.includes('skills/calc-conventions/SKILL.md') &&
      inPack.some((p) => p.startsWith('dist/ship/')) &&
      !inPack.some((p) => p.startsWith('src/')) &&
      !inPack.some((p) => p === '.env'),
    `打包清单：共 ${inPack.length} 个文件，dist / bin / skills 都在，src 与 .env 都不在`
  )

  // 6. 分层覆盖顺序：五层从低到高，后面的盖前面的
  const home = (tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mca-self-')))
  const userDir = path.join(home, 'user')
  const projectDir = path.join(home, 'project')
  await fs.mkdir(userDir, { recursive: true })
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(
    path.join(userDir, 'config.json'),
    JSON.stringify({ baseUrl: 'https://user.example/v1', model: 'user-model' })
  )
  await fs.writeFile(
    path.join(projectDir, 'config.json'),
    JSON.stringify({ model: 'project-model' })
  )
  delete process.env.LLM_BASE_URL
  delete process.env.LLM_MODEL
  const userWins = await loadShipConfig({}, { userDir, projectDir: path.join(home, 'none') })
  const projectWins = await loadShipConfig({}, { userDir, projectDir })
  process.env.LLM_MODEL = 'env-model'
  const envWins = await loadShipConfig({}, { userDir, projectDir })
  const flagWins = await loadShipConfig({ model: 'flag-model' }, { userDir, projectDir })
  delete process.env.LLM_MODEL
  check(
    userWins.model.value === 'user-model' &&
      projectWins.model.value === 'project-model' &&
      envWins.model.value === 'env-model' &&
      flagWins.model.value === 'flag-model' &&
      projectWins.baseUrl.value === 'https://user.example/v1',
    '分层顺序：默认 < 用户 < 项目 < 环境变量 < 命令行参数，逐级各赢一次；没被覆盖的键留在低层'
  )

  // 7. 每个值都说得出自己从哪来
  const traced = formatConfig(projectWins)
  check(
    projectWins.model.layer === 'project' &&
      projectWins.model.from.endsWith('config.json') &&
      projectWins.baseUrl.layer === 'user' &&
      traced.some((row) => row.includes('project 层')) &&
      traced.some((row) => row.includes('user 层')),
    `来源可追踪：model 来自 ${projectWins.model.layer} 层、baseUrl 来自 ${projectWins.baseUrl.layer} 层，--config 里逐行写明`
  )

  // 8. 配置文件里的密钥被拒绝，而且**说出来**——静默忽略会让用户以为工具坏了
  await fs.writeFile(
    path.join(projectDir, 'config.json'),
    JSON.stringify({ model: 'project-model', apiKey: 'sk-should-not-be-here', nonsense: 1 })
  )
  const secret = await loadShipConfig({}, { userDir, projectDir })
  check(
    secret.apiKey === '' &&
      secret.warnings.some((w) => w.includes('apiKey') && w.includes('不是放密钥的地方')) &&
      secret.warnings.some((w) => w.includes('nonsense')) &&
      !JSON.stringify(secret).includes('sk-should-not-be-here'),
    `密钥闸：配置文件里的 apiKey 被忽略并警告「配置文件不是放密钥的地方」，另有 ${secret.warnings.length - 1} 条键名问题也说了出来`
  )

  // 9. 密钥只从环境变量来，而且打印时打码
  process.env.LLM_API_KEY = 'sk-abcdefgh12345678'
  const withKey = await loadShipConfig({}, { userDir, projectDir })
  const masked = formatConfig(withKey).join('\n')
  check(
    withKey.apiKey === 'sk-abcdefgh12345678' &&
      maskKey(withKey.apiKey) === 'sk-a…5678（共 19 位）' &&
      !masked.includes('sk-abcdefgh12345678'),
    `密钥来源与打码：值只来自环境变量，--config 里显示成 ${maskKey(withKey.apiKey)}`
  )
  delete process.env.LLM_API_KEY

  // 10. 首次运行没有 key：给的是人话三选一，不是堆栈
  const bare = await loadShipConfig({}, { userDir, projectDir })
  // 自检自己是在 MOCK=1 下跑的，而这一条要验的正是**真实模式**缺 key 时的样子，
  // 所以显式把 mock 掰成 false——不掰的话这条断言会恒真，而且看起来还很绿
  const diagnosis = diagnose({ ...bare, mock: false })
  const text = diagnosis.lines.join('\n')
  check(
    diagnosis.blocking &&
      text.includes('export LLM_API_KEY=') &&
      text.includes('.env') &&
      text.includes('MOCK=1 mca') &&
      !text.includes('Error:') &&
      !diagnose({ ...bare, mock: true }).blocking,
    `首次运行引导：${diagnosis.lines.length} 行人话，三条路（环境变量 / .env / MOCK=1）都能直接复制`
  )

  // 11. 更新检查失败一律静默降级，启动不受影响
  const cacheFile = path.join(home, 'update-check.json')
  // 这一条自己包一层 try：**一条断言不该有能力弄死整个自检**。
  // 而这里恰好是最容易弄死它的那条——要验的就是「异常有没有被吞掉」
  let boom: Awaited<ReturnType<typeof checkUpdate>> | null = null
  let boomError = ''
  try {
    boom = await checkUpdate({
      current: '0.1.0',
      cacheFile,
      fetchLatest: async () => {
        throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
      },
    })
  } catch (error) {
    boomError = (error as Error).message
  }
  check(
    boom !== null && boom.latest === null && boom.notice === null && boom.checked === true,
    boomError
      ? `更新检查：取数的异常「${boomError}」被一路抛到了启动路径上——它应该被就地吞掉`
      : '更新检查：取数抛异常时返回「没查到」而不是把异常抬出去，屏幕上一个字都不多'
  )

  // 12. 节流：缓存没过期就一次网络都不发；有新版才出提示
  let calls = 0
  const fresh = await checkUpdate({
    current: '0.1.0',
    cacheFile,
    fetchLatest: async () => {
      calls += 1
      return '9.9.9'
    },
  })
  const stale = await checkUpdate({
    current: '0.1.0',
    cacheFile,
    now: Date.now() + CHECK_INTERVAL_MS + 1,
    fetchLatest: async () => {
      calls += 1
      return '9.9.9'
    },
  })
  check(
    fresh.checked === false &&
      calls === 1 &&
      stale.notice?.includes('9.9.9') === true &&
      isNewer('0.2.0', '0.10.0') === false &&
      isNewer('0.10.0', '0.2.0'),
    `节流：${CHECK_INTERVAL_MS / 3600000} 小时内只查一次（这一段共查了 ${calls} 次），版本比的是数字不是字符串`
  )
  // 临时目录的清理不在这里，在文件末尾的 finally 里——理由见那段注释

  // 13. 一次性任务：非交互下写操作默认被拒，仓库一个字节都没变
  applyShipConfig(await loadShipConfig())
  const parsed = parseArgv(['--task', '修一下失败的测试', '--yes', '--model=x'])
  await seedRepo()
  const before = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  const dry = await runTask({ line: '修一下失败的测试', yes: false, write: () => {} })
  const after = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  check(
    parsed.task === '修一下失败的测试' &&
      parsed.yes === true &&
      parsed.model === 'x' &&
      dry.blocked > 0 &&
      before === after,
    `非交互默认只读：--task 解析出「${parsed.task}」；不加 --yes 时 ${dry.blocked} 次写操作被拒，calc.js 一字未改`
  )

  // 14. 加上 --yes 就真干活：端到端把失败的用例修绿
  //
  // 工具串里的 read_file 不是凑数的：D18 的 read-before-write 钩子会把「凭记忆直接
  // edit_file」在 pre_tool 拦下，**工具根本不执行**。被拦下时剧本照样跑完、退出码照样 0，
  // 所以这一条同时比对改动前后的文件内容——只看退出码的话，一次什么都没做的运行
  // 看起来和一次成功的运行一模一样。
  await seedRepo()
  const beforeFix = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  const done = await runTask({ line: '修一下失败的测试', yes: true, write: () => {} })
  const fixed = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  check(
    done.code === 0 &&
      done.blocked === 0 &&
      done.tools.join(',') === 'read_file,edit_file,run_command' &&
      fixed !== beforeFix &&
      fixed.includes("throw new Error('divide by zero')"),
    `--task --yes 端到端：调了 ${done.tools.join(' 与 ')}，calc.js 真的被改过（${beforeFix.length} → ${fixed.length} 字符）且除零保护已经在文件里，退出码 ${done.code}`
  )

  out(`${passed}/${passed + failed} 通过`)
  out(
    '（全部离线可复现：不发任何网络请求——更新检查喂的是注入的假取数动作；' +
      '构建与打包清单是真跑的，配置分层在临时目录里摆出四层。' +
      '全局安装那一段太慢，不在自检里，用 pnpm verify:pack 单独跑）'
  )
  if (failed > 0) process.exitCode = 1
}

/** 列出目录下所有文件的相对路径。按目录遍历，不用手写清单——理由同 scripts/build.mjs */
async function walk(dir: string, base: string = dir): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await walk(full, base)))
    else found.push(path.relative(base, full))
  }
  return found.sort()
}

// 清理写在 finally 而不是第 12 项末尾：starter 的 ship/update.ts 还是 TODO，
// 第 11、12 项会真的抛出来，异常一路越过后面所有代码——包括那行 fs.rm。
// 于是每跑一次 starter 自检，系统临时目录里就多留一个 mca-self-XXXXXX 再也没人删。
try {
  await main()
} finally {
  if (tempHome) await fs.rm(tempHome, { recursive: true, force: true })
}
