/**
 * 自检入口：不进 REPL，逐项验证今天该成立的六件事，打印勾叉后按结果退出。
 *
 * 为什么每天都要有它：mca 是 REPL，在无交互终端（CI、脚本、别的 Agent 的 shell）下
 * stdin 会立刻 EOF，程序打印一行提示就退出，exit code 是 0 但一行业务代码都没跑。
 * 只看退出码，你会拿到一个「跑通了」的假结论。
 */
import { spawnSync } from 'node:child_process'
import { stdout } from 'node:process'
import { newSession } from './repl.js'
import { run } from './kernel/loop.js'
import { MarkdownStream, isFence, looksUnsettled, renderTurn, styleInline } from './render.js'
import { createProvider } from './providers/index.js'
import type { AgentEvent } from './kernel/types.js'
import { seedRepo } from './seed.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

/** 去掉 ANSI 转义与光标控制，才能拿渲染结果和原文比 */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
}

async function askOffline(
  userText: string
): Promise<{ text: string; deltas: number; screen: string; codeBlocks: number }> {
  const session = newSession(() => {})
  session.messages.push({ role: 'user', content: userText })
  let screen = ''
  const summary = await renderTurn(
    run({ provider: createProvider(), registry: session.registry, messages: session.messages }),
    (chunk) => {
      screen += chunk
    },
    { tty: true }
  )
  return { text: summary.text, deltas: summary.deltas, screen, codeBlocks: summary.codeBlocks }
}

async function main(): Promise<void> {
  // 1. 起点一致：每次自检都从重新生成沙盒仓库开始
  const files = await seedRepo()
  check(files.length === 4, `沙盒仓库已生成（work/repo，${files.length} 个文件）`)

  // 2. 真的在「流」：一段两百字左右的回答被切成很多片
  const streaming = await askOffline('讲讲流式')
  check(streaming.deltas > 20, `一段回答被切成 ${streaming.deltas} 个分片逐片渲染`)

  // 3. 渲染没丢字：屏幕上的字（去掉 ANSI）等于所有分片拼起来的真值
  const screenText = stripAnsi(streaming.screen)
  check(
    screenText.includes(streaming.text) && streaming.text.length > 100,
    `分片拼接与屏幕内容逐字一致（${streaming.text.length} 个字符）`
  )

  // 4. 代码块跨分片不闪：未定型的 `` 不上样式，定型后的围栏才切换代码模式
  const unsettled = looksUnsettled('``') && looksUnsettled('这里是 `data') && looksUnsettled('很**')
  const settled = !looksUnsettled('这里是 `data` 行') && isFence('```ts')
  const styled = styleInline('这里是 `data` 行').includes('\u001b[36m')
  const withCode = await askOffline('解析器长什么样')
  const frames = withCode.screen.split('\r')
  // 「误上色」的定义：某一帧里 `` 还没长成围栏，却已经被按行内代码上了色
  const flickers = frames.filter(
    (frame) => /``[^`]/.test(stripAnsi(frame)) && frame.includes('\u001b[36m')
  ).length
  check(
    unsettled && settled && styled && flickers === 0,
    `围栏与行内标记跨分片到达时不误判（${frames.length} 帧重画、${flickers} 帧误上色、` +
      `未定型判定${unsettled && settled ? '正确' : '错误'}、代码块 ${withCode.codeBlocks} 个）`
  )

  // 5. 打断：中途取消，已经收到的文本要留住，事件是 done/aborted 而不是异常
  const controller = new AbortController()
  const session = newSession(() => {})
  session.messages.push({ role: 'user', content: '讲讲流式' })
  const events = run({
    provider: createProvider(),
    registry: session.registry,
    messages: session.messages,
    signal: controller.signal,
  })
  const seen: AgentEvent[] = []
  for await (const event of events) {
    seen.push(event)
    if (seen.filter((e) => e.type === 'text').length === 5) controller.abort()
  }
  const kept = session.messages.at(-1)
  const last = seen.at(-1) as { type?: string; reason?: string } | undefined
  check(
    last?.type === 'done' &&
      last.reason === 'aborted' &&
      kept?.role === 'assistant' &&
      String(kept.content).length > 0,
    `打断后收到 done/${last?.reason ?? '无'}，收到 ${seen.filter((e) => e.type === 'text').length} ` +
      `个分片就停住并保留了 ${String(kept?.content ?? '').length} 个字符`
  )

  // 6. 断流：INJECT=truncated 起一个子进程跑真实 REPL，看它说人话还是打堆栈
  const child = spawnSync(process.argv[0], [...process.execArgv, process.argv[1]], {
    input: '讲讲流式\n/exit\n',
    encoding: 'utf8',
    env: { ...process.env, SELFTEST: '', MOCK: '1', INJECT: 'truncated' },
  })
  const childOut = `${child.stdout ?? ''}${child.stderr ?? ''}`
  check(
    childOut.includes('流在中途断开') && !childOut.includes('at async'),
    'INJECT=truncated 时提示「流在中途断开」，没有堆栈'
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

await main()
