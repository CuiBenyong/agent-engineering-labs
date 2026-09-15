/**
 * 自检入口：不进 REPL，逐项验证今天该成立的七件事，打印勾叉后按结果退出。
 *
 * 为什么每天都要有它：mca 是 REPL，在无交互终端（CI、脚本、别的 Agent 的 shell）下
 * stdin 会立刻 EOF，程序打印一行提示就退出，exit code 是 0 但一行业务代码都没跑。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { newSession } from './repl.js'
import { run } from './kernel/loop.js'
import { ToolCallAccumulator } from './kernel/tool-calls.js'
import { MAX_RESULT_CHARS, truncateResult } from './kernel/truncate.js'
import { renderTurn, type RenderSummary } from './render.js'
import { createProvider } from './providers/index.js'
import { seedRepo, REPO_DIR } from './seed.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
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

async function main(): Promise<void> {
  await seedRepo()

  // 1. 归并：index 从 1 开始、分片交错到达，也要归并出两个调用且顺序按 index
  const acc = new ToolCallAccumulator()
  acc.push({ index: 2, id: 'b', name: 'grep' })
  acc.push({ index: 1, id: 'a', name: 'glob' })
  acc.push({ index: 2, argsDelta: '{"pattern"' })
  acc.push({ index: 1, argsDelta: '{"pattern":' })
  acc.push({ index: 2, argsDelta: ':"divide"}' })
  acc.push({ index: 1, argsDelta: '"**/*.js"}' })
  const merged = acc.drain()
  check(
    merged.length === 2 &&
      merged[0]?.name === 'glob' &&
      merged[1]?.name === 'grep' &&
      JSON.parse(merged[0]?.args ?? '{}').pattern === '**/*.js',
    `交错到达且 index 从 1 起的分片归并出 ${merged.length} 个调用，参数拼接后是合法 JSON`
  )

  // 2. 三件套跑通：模型自己 glob → grep → read_file，最后给结论
  const explore = await ask('帮我看看这个仓库，测试为什么红')
  const names = explore.tools.map((t) => t.name)
  check(
    names.join('→') === 'glob→grep→read_file' && explore.tools.every((t) => t.ok),
    `模型自己调了三个只读工具（${names.join(' → ')}），全部成功`
  )

  // 3. 工具描述与 schema：required 字段齐全，只读标记都为真
  const registry = newSession(() => {}).registry
  const schemaOk = registry.list().every((tool) => {
    const required = tool.parameters.required
    return (
      tool.readOnly &&
      tool.description.length > 20 &&
      Array.isArray(required) &&
      required.length > 0
    )
  })
  check(schemaOk, `${registry.size} 个工具都有描述、必填参数与只读标记`)

  // 4. 截断：单个结果上限 8000 字符，从中间截并注明截掉多少
  const big = 'x'.repeat(20000)
  const truncated = truncateResult({ ok: true, content: big })
  check(
    truncated.content.length < big.length &&
      truncated.content.includes('中间已截断 12000 字符') &&
      truncated.meta?.truncated === true &&
      MAX_RESULT_CHARS === 8000,
    `20000 字符的结果被截到 ${truncated.content.length} 字符，并注明截掉了 12000 字符`
  )

  // 5. 端到端的截断：生成一个大文件，让模型自己去读
  await fs.writeFile(
    path.join(REPO_DIR, 'src/generated.js'),
    Array.from({ length: 900 }, (_, i) => `export const value${i} = ${i} // 自动生成的一行`).join(
      '\n'
    ),
    'utf8'
  )
  const bigRead = await ask('读一下那个大文件')
  const firstResult = bigRead.tools[0]
  check(
    firstResult?.truncated === true && firstResult.name === 'read_file',
    `read_file 读大文件时结果被截断（回灌 ${firstResult?.chars ?? 0} 字符）`
  )

  // 6. 读权限也有边界：路径跑出工作目录要被挡下来，并且是 ok 为 false 而不是抛异常
  const registry2 = newSession(() => {}).registry
  const escape = await registry2.execute(
    { id: 'x', name: 'read_file', args: JSON.stringify({ path: '../../package.json' }) },
    { cwd: REPO_DIR, signal: new AbortController().signal, log: () => {} }
  )
  check(
    !escape.ok && escape.content.includes('超出了工作目录'),
    `读工作目录外的路径被挡下（${escape.content.slice(0, 24)}…）`
  )

  // 7. 非法参数不抛异常：起一个子进程注入 bad_args，看它是回灌纠正还是崩
  const child = spawnSync(process.argv[0], [...process.execArgv, process.argv[1]], {
    input: '帮我看看这个仓库\n/exit\n',
    encoding: 'utf8',
    env: { ...process.env, SELFTEST: '', MOCK: '1', INJECT: 'bad_args' },
  })
  const childOut = `${child.stdout ?? ''}${child.stderr ?? ''}`
  check(
    childOut.includes('参数不是合法 JSON') && !childOut.includes('at async') && child.status === 0,
    'INJECT=bad_args 时非法参数被回灌纠正，循环没有抛异常'
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

await main()
