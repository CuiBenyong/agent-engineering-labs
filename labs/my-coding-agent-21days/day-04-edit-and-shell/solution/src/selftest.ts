/**
 * 自检入口：不进 REPL，逐项验证今天该成立的七件事，打印勾叉后按结果退出。
 *
 * 今天的核心一项是第 4 条：从红到绿的完整闭环。它不是「打印一句成功」——
 * 它真的起子进程跑 node --test、真的把文件写回磁盘、真的再跑一次。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { newSession } from './repl.js'
import { run } from './kernel/loop.js'
import { renderTurn, type RenderSummary } from './render.js'
import { createProvider } from './providers/index.js'
import { seedRepo, REPO_DIR } from './seed.js'
import type { ToolContext, ToolResult } from './kernel/types.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const ctx = (): ToolContext => ({
  cwd: REPO_DIR,
  signal: new AbortController().signal,
  log: () => {},
})

async function callTool(name: string, args: unknown): Promise<ToolResult> {
  const registry = newSession(() => {}).registry
  return registry.execute({ id: 't', name, args: JSON.stringify(args) }, ctx())
}

async function ask(userText: string): Promise<RenderSummary> {
  const session = newSession(() => {})
  session.messages.push({ role: 'user', content: userText })
  return renderTurn(
    run({
      provider: createProvider(),
      registry: session.registry,
      messages: session.messages,
      cwd: REPO_DIR,
    }),
    () => {},
    { tty: false }
  )
}

const OLD_DIVIDE = 'export function divide(a, b) {\n  return a / b\n}'

async function main(): Promise<void> {
  await seedRepo()

  // 1. 起点确认：沙盒仓库刚生成时，测试是红的（一个用例失败）
  const before = await callTool('run_command', { command: 'node --test' })
  check(
    !before.ok && /fail 1|# fail 1/.test(before.content),
    `刚生成的沙盒仓库测试是红的（退出码 ${before.meta?.exitCode}）`
  )

  // 2. 精确替换：改一处，行数变化可预期
  const edited = await callTool('edit_file', {
    path: 'src/calc.js',
    old_string: OLD_DIVIDE,
    new_string: OLD_DIVIDE.replace(
      '  return',
      "  if (b === 0) throw new Error('divide by zero')\n  return"
    ),
  })
  const source = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  check(
    edited.ok && source.includes('divide by zero') && edited.meta?.lineDelta === 1,
    `精确替换改掉了 divide（${edited.content}）`
  )

  // 3. 冲突检测：原文对不上、原文不唯一，两种都必须失败且不动文件
  const stale = await callTool('edit_file', {
    path: 'src/calc.js',
    old_string: 'export function divide(a,b) {\n  return a / b\n}', // 少一个空格
    new_string: 'whatever',
  })
  const ambiguous = await callTool('edit_file', {
    path: 'src/calc.js',
    old_string: 'return a',
    new_string: 'return b',
  })
  const untouched = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  check(
    !stale.ok &&
      stale.content.includes('找不到') &&
      !ambiguous.ok &&
      ambiguous.content.includes('出现了 3 次') &&
      untouched === source,
    '原文对不上与原文不唯一都被拒绝，文件一个字节都没动'
  )

  // 4. 端到端闭环：模型自己跑测试 → 读 → 改 → 再跑，从红到绿
  await seedRepo()
  const fixed = await ask('帮我修一下失败的测试')
  const commands = fixed.tools.filter((t) => t.name === 'run_command')
  const finalSource = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  const after = await callTool('run_command', { command: 'node --test' })
  check(
    fixed.tools.map((t) => t.name).join('→') === 'run_command→read_file→edit_file→run_command' &&
      commands.length === 2 &&
      finalSource.includes('divide by zero') &&
      after.ok,
    `模型自己走完「跑测试→读→改→再跑」，第二次测试全绿（${fixed.tools.length} 次工具调用）`
  )

  // 5. 输出上限：一条输出巨大的命令不许把上下文顶满
  const noisy = await callTool('run_command', {
    command: 'node -e "for (let i = 0; i < 20000; i++) console.log(\'line\', i)"',
  })
  check(
    noisy.meta?.truncatedOutput === true &&
      Number(noisy.meta?.stdoutChars) <= 4000 &&
      noisy.content.length < 9000,
    `两万行输出的命令只留下 ${noisy.meta?.stdoutChars} 字符标准输出，回灌 ${noisy.content.length} 字符`
  )

  // 6. create_file：新建成功，已存在时失败且不覆盖
  const created = await callTool('create_file', {
    path: 'src/util.js',
    content: 'export const x = 1\n',
  })
  const again = await callTool('create_file', { path: 'src/util.js', content: '// 覆盖你' })
  const kept = await fs.readFile(path.join(REPO_DIR, 'src/util.js'), 'utf8')
  check(
    created.ok &&
      !again.ok &&
      again.content.includes('已经存在') &&
      kept === 'export const x = 1\n',
    '新建文件成功，第二次新建被拒绝且没有覆盖原内容'
  )

  // 7. 超时：起一个子进程注入 timeout，卡死的命令要被杀掉、循环不能挂住
  const child = spawnSync(process.argv[0], [...process.execArgv, process.argv[1]], {
    input: '帮我修一下失败的测试\n/exit\n',
    encoding: 'utf8',
    // 15 秒够了：solution 在 2 秒就杀掉了；杀不掉的实现会在这里被 spawnSync 掐断
    timeout: 15_000,
    env: { ...process.env, SELFTEST: '', MOCK: '1', INJECT: 'timeout' },
  })
  const childOut = `${child.stdout ?? ''}${child.stderr ?? ''}`
  check(
    childOut.includes('命令超时被杀掉') && child.status === 0,
    'INJECT=timeout 时卡死的命令被杀掉，循环继续往下走'
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

await main()
