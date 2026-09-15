/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十一件事，打印勾叉后按结果退出。
 *
 * 今天有一个结构上的新东西：**六种注入里有五种要各起一个子进程来验。**
 * 原因是 providers/mock.ts 与两个工具都在**模块加载时**读一次 INJECT，
 * 同一个进程里改 process.env.INJECT 是没用的（模块已经加载完了）。
 * 所以父进程按剧本 spawn 自己，每次带一个不同的 INJECT，子进程跑完一轮任务后
 * 打印一行 RESULT 加 JSON，父进程读回来做断言。
 *
 * 这个做法从 D2 起就是本课的固定套路，不要改成在同一个进程里改环境变量——
 * 那样你验的是「你以为的注入」，不是真的注入。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { newSession } from './commands.js'
import { isCancelKey } from './repl.js'
import { run, type RunOptions } from './kernel/loop.js'
import { renderTurn, type RenderSummary } from './render.js'
import { createProvider } from './providers/index.js'
import { diagnoseStreamError, diagnoseToolResult } from './kernel/errors.js'
import { backoffDelay } from './kernel/retry.js'
import { RateLimitError, StreamTruncatedError } from './providers/gateway.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { contentToText, type Message } from './kernel/types.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

interface TurnResult {
  summary: RenderSummary
  messages: Message[]
}

/** 跑一轮完整任务。审批在自检里一律按「这次可以」回答——今天验的不是审批 */
async function turn(userText: string, extra: Partial<RunOptions> = {}): Promise<TurnResult> {
  const session = newSession(() => {})
  session.messages.push({ role: 'user', content: userText })
  const summary = await renderTurn(
    run({
      provider: createProvider(),
      registry: session.registry,
      messages: session.messages,
      cwd: REPO_DIR,
      gate: {
        state: session.permissions,
        approve: async () => ({ approved: true, scope: 'once' }),
      },
      ...extra,
    }),
    () => {},
    { tty: false }
  )
  return { summary, messages: session.messages }
}

/** 子进程模式：跑一轮基准任务，把结果压成一行 JSON 交给父进程 */
async function reportOneTurn(): Promise<void> {
  await seedRepo()
  const { summary, messages } = await turn('帮我修一下失败的测试')
  const source = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  const feedback = messages.filter((m) => m.role === 'tool').map((m) => contentToText(m.content))
  out(
    `RESULT ${JSON.stringify({
      tools: summary.tools,
      retries: summary.retries,
      error: summary.error,
      deltas: summary.deltas,
      textLength: summary.text.length,
      guarded: source.includes('divide by zero'),
      feedback,
    })}`
  )
}

interface ChildReport {
  tools: Array<{ name: string; ok: boolean; chars: number; blockedBy?: string }>
  retries: number
  error: string | null
  deltas: number
  textLength: number
  guarded: boolean
  feedback: string[]
}

/** 起一个带指定 INJECT 的子进程，跑一轮基准任务，读回它的 JSON */
function injectedTurn(inject: string): ChildReport {
  const child = spawnSync(process.argv[0], [...process.execArgv, process.argv[1]], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, MOCK: '1', SELFTEST: '1', SELFTEST_CASE: 'one-turn', INJECT: inject },
  })
  const line = (child.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '))
  if (!line)
    throw new Error(`子进程没有给出结果（INJECT=${inject}）：${child.stderr?.slice(0, 400)}`)
  return JSON.parse(line.slice('RESULT '.length)) as ChildReport
}

async function main(): Promise<void> {
  await seedRepo()

  // 1. 错误分类：同一个断流错误，吐过字与没吐过字的处理是相反的
  const rateLimit = diagnoseStreamError(new RateLimitError(200), 0)
  const earlyTruncate = diagnoseStreamError(new StreamTruncatedError(0), 0)
  const lateTruncate = diagnoseStreamError(new StreamTruncatedError(7), 7)
  const unknown = diagnoseStreamError(new Error('网关返回 500'), 0)
  const toolFailure = diagnoseToolResult({ ok: false, content: '找不到那段 old_string' })
  check(
    rateLimit.handling === 'retry' &&
      earlyTruncate.handling === 'retry' &&
      lateTruncate.handling === 'surface' &&
      unknown.handling === 'surface' &&
      toolFailure.handling === 'feedback',
    '错误分类正确：限流与「还没吐字就断」重试，「吐过字才断」抬头，工具失败一律回灌'
  )

  // 2. 退避带抖动：窗口按 2 的幂增长，实际等待落在窗口后半段，随机源不同结果就不同
  const fixed = [1, 2, 3].map((n) => backoffDelay(n, { baseMs: 400, random: () => 0.5 }))
  const low = backoffDelay(2, { baseMs: 400, random: () => 0 })
  const high = backoffDelay(2, { baseMs: 400, random: () => 1 })
  const capped = backoffDelay(9, { baseMs: 400, capMs: 8000, random: () => 1 })
  check(
    fixed.join(',') === '300,600,1200' && low === 400 && high === 800 && capped === 8000,
    `退避窗口按 2 的幂增长（${fixed.join('ms / ')}ms），抖动把第二次摊在 ${low}–${high}ms 之间，上限 ${capped}ms`
  )

  // 3. INJECT=rate_limit：第一次 429，退避之后重试成功，任务照常做完
  const limited = injectedTurn('rate_limit')
  check(
    limited.retries === 1 &&
      limited.error === null &&
      limited.guarded &&
      limited.tools.length === 4,
    `限流退避重试了 ${limited.retries} 次并成功，任务照常完成（${limited.tools.length} 次工具调用，代码已加除零保护）`
  )

  // 4. INJECT=tool_error：写入失败被回灌，模型原样重试一次就成了
  const toolError = injectedTurn('tool_error')
  const failedEdits = toolError.tools.filter((t) => t.name === 'edit_file' && !t.ok).length
  const okEdits = toolError.tools.filter((t) => t.name === 'edit_file' && t.ok).length
  check(
    failedEdits === 1 &&
      okEdits === 1 &&
      toolError.guarded &&
      toolError.feedback.some((f) => f.includes('磁盘临时不可写')),
    `工具失败回灌后自纠成功：edit_file 失败 ${failedEdits} 次、成功 ${okEdits} 次，最终代码修好了`
  )

  // 5. INJECT=bad_args：参数非法被逐次回灌；这一段故意让它自纠不成功，最后向用户抬头
  const badArgs = injectedTurn('bad_args')
  const jsonComplaints = badArgs.feedback.filter((f) => f.includes('不是合法 JSON')).length
  check(
    jsonComplaints === 4 &&
      badArgs.tools.every((t) => !t.ok) &&
      badArgs.error === null &&
      badArgs.textLength > 0,
    `参数非法被回灌 ${jsonComplaints} 次且原文一起给回去了；四次都没自纠成功，于是它停下来向用户说明`
  )

  // 6. INJECT=truncated：吐过字之后断流，不重试，已收到的文本保留
  const truncated = injectedTurn('truncated')
  check(
    truncated.retries === 0 &&
      truncated.deltas === 3 &&
      truncated.textLength === 12 &&
      Boolean(truncated.error?.includes('流在中途断开')),
    `断流没有触发重试（已收到 ${truncated.deltas} 个分片、${truncated.textLength} 个字符，全部保留），改为向用户抬头`
  )

  // 7. INJECT=timeout：命令卡死被杀掉，失败信息里带着下一步动作
  const timedOut = injectedTurn('timeout')
  check(
    timedOut.tools.length === 1 &&
      !timedOut.tools[0]?.ok &&
      timedOut.feedback.some((f) => f.includes('命令超时被杀掉') && f.includes('把命令拆小')),
    '卡死的命令被超时杀掉，回灌里带着「把命令拆小」这类可执行的下一步'
  )

  // 8. INJECT=loop：同工具同参数连续三次，第三次被打断并回灌说明
  const looping = injectedTurn('loop')
  const blocked = looping.tools.filter((t) => t.blockedBy === 'repeat')
  check(
    looping.tools.length === 3 &&
      blocked.length === 1 &&
      looping.feedback.some((f) => f.includes('完全相同的参数')) &&
      looping.error === null,
    `打转检测在第 ${looping.tools.length} 次同参数调用时打断（挡下 ${blocked.length} 次），并回灌了换做法的建议`
  )

  // 9. 取消链路：按下取消之后，卡在子进程里的命令必须真的停下来
  await seedRepo()
  const controller = new AbortController()
  const cancelAt = setTimeout(() => controller.abort(), 400)
  const startedAt = Date.now()
  const cancelled = await turn('跑个长命令，不要停', { signal: controller.signal })
  clearTimeout(cancelAt)
  const cancelMs = Date.now() - startedAt
  const cancelFeedback = cancelled.messages
    .filter((m) => m.role === 'tool')
    .map((m) => contentToText(m.content))
    .join('\n')
  check(
    cancelled.summary.interrupted && cancelFeedback.includes('命令被用户取消') && cancelMs < 4000,
    `取消一路传到子进程：命令在 ${cancelMs}ms 就停了（它自己要跑 15 秒），这一轮被标记为已打断`
  )

  // 10. 三条硬上限各自都能触发，且触发的是预期那一条
  await seedRepo()
  const byRounds = await turn('帮我修一下失败的测试', { limits: { maxRounds: 2 } })
  await seedRepo()
  const byTime = await turn('帮我修一下失败的测试', { limits: { maxMs: 50 } })
  await seedRepo()
  const byTokens = await turn('帮我修一下失败的测试', { limits: { maxTokens: 10 } })
  check(
    Boolean(byRounds.summary.error?.includes('轮数上限')) &&
      byRounds.summary.tools.length === 2 &&
      Boolean(byTime.summary.error?.includes('时长上限')) &&
      Boolean(byTokens.summary.error?.includes('用量上限')),
    '轮数、时长、用量三条上限各自都能把循环停下来，且报出的是触发的那一条'
  )

  // 11. 哪些按键算取消：Esc 与 Ctrl+C，其余一概不算
  check(
    isCancelKey({ name: 'escape' }) &&
      isCancelKey({ name: 'c', ctrl: true }) &&
      !isCancelKey({ name: 'c' }) &&
      !isCancelKey({ name: 'escape', meta: true }) &&
      !isCancelKey(undefined),
    '取消按键判定正确：Esc 与 Ctrl+C 算取消，单独的 c 与 Alt 组合键不算'
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

if (process.env.SELFTEST_CASE === 'one-turn') {
  await reportOneTurn()
} else {
  await main()
}
