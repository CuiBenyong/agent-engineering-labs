/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十五件事，打印勾叉后按结果退出。
 *
 * 大半项是纯数据结构的断言（清单的不变量、面板的行、停滞的阈值），可以直接调用。
 * 只有 `INJECT=loop` 那一项必须**跨进程**：`INJECT` 在模块加载时就被读进常量，
 * 同一个进程里改不了。所以父进程 spawn 一次自己，子进程跑一轮打转任务并把结果
 * 压成一行 JSON 交回来——这是本课从第六天起的固定手法。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { stdout } from 'node:process'
import { BASE_PROMPT, newSession } from './commands.js'
import { run } from './kernel/loop.js'
import { renderTurn, type RenderSummary } from './render.js'
import { createProvider } from './providers/index.js'
import { SessionLog, SESSIONS_DIR } from './session/log.js'
import { recordTurn } from './session/record.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { contentToText, type Message } from './kernel/types.js'
import { instructionSources, loadInstructions } from './instructions/index.js'
import { seedInstructions } from './instructions/fixtures.js'
import { TodoList, TODO_STATUSES } from './todo/list.js'
import { createTodoTool } from './todo/tool.js'
import { TodoPanel, renderRows } from './todo/panel.js'
import { NUDGE_PREFIX, StallDetector } from './todo/stall.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const ctx = { cwd: REPO_DIR, signal: new AbortController().signal, log: () => {} }

/** 直接调一次 update_todos，绕过模型。返回工具结果 */
async function callTool(list: TodoList, args: unknown) {
  return createTodoTool(list).run(args, ctx)
}

const PLAN = [
  { id: 't1', text: '跑测试', status: 'pending' },
  { id: 't2', text: '修 divide', status: 'pending' },
  { id: 't3', text: '再跑一次', status: 'pending' },
]

interface TurnResult {
  summary: RenderSummary
  messages: Message[]
  todos: TodoList
}

/** 跑一轮完整任务。审批一律按「这次可以」回答——今天验的不是审批 */
async function turn(userText: string): Promise<TurnResult> {
  const instructions = await loadInstructions({ ...instructionSources(), base: BASE_PROMPT })
  const todos = new TodoList()
  const session = newSession(() => {}, await SessionLog.create(), { instructions, todos })
  session.messages.push({ role: 'user', content: userText })
  const summary = await renderTurn(
    recordTurn(
      session.log,
      session.messages,
      run({
        provider: createProvider(),
        registry: session.registry,
        messages: session.messages,
        cwd: REPO_DIR,
        todos: session.todos,
        gate: {
          state: session.permissions,
          approve: async () => ({ approved: true, scope: 'session' }),
        },
      })
    ),
    () => {},
    { tty: false }
  )
  return { summary, messages: session.messages, todos: session.todos }
}

interface ChildReport {
  tools: Array<{ name: string; ok: boolean; blockedBy?: string }>
  retries: number
  error: string | null
  nudges: string[]
  done: number
  running: string | null
  revision: number
}

/** 子进程模式：跑一轮打转任务，把结果压成一行 JSON 交给父进程 */
async function reportLoopTurn(): Promise<void> {
  await seedRepo()
  await seedInstructions(true)
  const { summary, messages, todos } = await turn('再看看 calc.js')
  const nudges = messages
    .filter((m) => m.role === 'user' && contentToText(m.content).startsWith(NUDGE_PREFIX))
    .map((m) => contentToText(m.content))
  out(
    `RESULT ${JSON.stringify({
      tools: summary.tools.map((t) => ({ name: t.name, ok: t.ok, blockedBy: t.blockedBy })),
      retries: summary.retries,
      error: summary.error,
      nudges,
      done: todos.counts.done,
      running: todos.active?.text ?? null,
      revision: todos.revision,
    })}`
  )
}

function loopTurn(): ChildReport {
  const child = spawnSync(
    process.argv[0] as string,
    [...process.execArgv, process.argv[1] as string],
    {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, MOCK: '1', SELFTEST: '1', SELFTEST_CASE: 'loop-turn', INJECT: 'loop' },
    }
  )
  const line = (child.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '))
  if (!line) throw new Error(`子进程没有给出结果：${child.stderr?.slice(0, 400)}`)
  return JSON.parse(line.slice('RESULT '.length)) as ChildReport
}

async function main(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true })
  await seedRepo()
  await seedInstructions(true)

  // 1. 状态只有三种：写错了被拒绝，提示原样列出三个合法值，清单一个字没动
  const list = new TodoList()
  const bogus = await callTool(list, {
    items: [{ text: '干点什么', status: 'blocked' }],
  })
  check(
    bogus.ok === false &&
      bogus.content.includes('blocked') &&
      TODO_STATUSES.every((status) => bogus.content.includes(status)) &&
      list.all.length === 0,
    `非法状态被拒绝并列出三个合法值，清单没有被改动：${bogus.content.slice(0, 46)}…`
  )

  // 2. 一次只允许一个进行中：整表里两个 in_progress → 拒绝 + 纠正话术
  const twoRunning = await callTool(list, {
    items: PLAN.map((item, i) => ({ ...item, status: i < 2 ? 'in_progress' : 'pending' })),
  })
  check(
    twoRunning.ok === false &&
      twoRunning.content.includes('一次只能有一个') &&
      twoRunning.content.includes('跑测试') &&
      twoRunning.content.includes('修 divide') &&
      list.revision === 0,
    '整表里两个 in_progress 被拒绝，纠正话术点名了是哪两条，清单版本号没变'
  )

  // 3. 两种写法都能用：整表替换建表，单项更新改一条
  const built = await callTool(list, {
    items: PLAN.map((item, i) => ({ ...item, status: i === 0 ? 'in_progress' : 'pending' })),
  })
  const oneStep = await callTool(list, { id: 't1', status: 'done' })
  check(
    built.ok &&
      oneStep.ok &&
      list.counts.done === 1 &&
      list.counts.pending === 2 &&
      list.active === undefined,
    `整表替换建出 3 条、单项更新把 t1 改成已完成（${list.counts.done}/3 已完成）`
  )

  // 4. 单项更新时抢占也被拒：另一条还在进行中
  await callTool(list, { id: 't2', status: 'in_progress' })
  const preempt = await callTool(list, { id: 't3', status: 'in_progress' })
  check(
    preempt.ok === false && preempt.content.includes('修 divide') && list.active?.id === 't2',
    '有一条在进行中时，把另一条也设为进行中被拒绝，当前进行中的仍然是它'
  )

  // 5. 写同一个状态不算改动：revision 不动，于是「反复写同一状态」骗不过停滞检测
  const before = list.revision
  const noop = await callTool(list, { id: 't2', status: 'in_progress' })
  check(
    noop.ok === true && list.revision === before && noop.content.includes('本来就是'),
    '把一条写成它已经是的状态：允许但不算改动，版本号没变'
  )

  // 6. 重开计数：done 又变回来算一次
  await callTool(list, { id: 't1', status: 'pending' })
  check(list.reopenCount('t1') === 1 && list.maxReopen === 1, '已完成的任务被重新打开时记了一次')

  // 7. 不存在的 id：告诉它现在的清单长什么样，并指出新增要用整表替换
  const missing = await callTool(list, { id: 't9', status: 'done' })
  check(
    missing.ok === false && missing.content.includes('t9') && missing.content.includes('整表替换'),
    '改一个不存在的 id 时，回灌里带上了现在的清单与「新增请用整表替换」'
  )

  // 8. 面板的行：表头带 已完成/总数，进行中那一条带箭头
  const rows = renderRows(list)
  check(
    rows[0]?.includes('0/3 已完成') === true &&
      rows.some((row) => row.includes('← 进行中')) &&
      rows.length === 4,
    `面板 ${rows.length} 行：${rows[0]}`
  )

  // 9. 面板与流式文本不打架：每片正文前先恢复光标并清屏，写完再保存并画回来
  const chunks: string[] = []
  const panel = new TodoPanel(list, (chunk) => chunks.push(chunk), true)
  panel.show()
  panel.wrap((chunk) => chunks.push(chunk))('正文一片')
  const joined = chunks.join('')
  check(
    joined.includes('[s') &&
      joined.indexOf('[u[0J') < joined.indexOf('正文一片') &&
      joined.lastIndexOf('[s') > joined.indexOf('正文一片'),
    '正文写入被夹在「恢复光标 + 清屏」与「保存光标 + 重画」之间，面板位置不动'
  )

  // 10. 清单工具是只读的：它不动用户文件，所以不该惊动审批门
  const tool = createTodoTool(new TodoList())
  check(tool.readOnly === true, '清单工具标成只读：改一条状态不该让用户按一次 y')

  // 11. 停滞检测的豁免：清单一次都没被写过时不催（三步以内的活儿不该被催）
  const quiet = new StallDetector()
  const never = [1, 2, 3, 4, 5].map((round) => quiet.check(round, 0, 0))
  check(
    never.every((signal) => signal === null),
    '清单从没被写过时，转了 5 轮也不提醒（没用清单不等于停滞）'
  )

  // 12. 停滞检测的两级干预：第一次提醒，第二次停
  const stalls = new StallDetector()
  stalls.check(1, 1, 0)
  const first = stalls.check(4, 1, 0)
  const second = stalls.check(5, 1, 0)
  check(
    first?.action === 'nudge' &&
      first.message.startsWith(NUDGE_PREFIX) &&
      second?.action === 'stop',
    `清单 3 轮不动先提醒（${first?.reason}），再一次就停下这一轮（${second?.action}）`
  )

  // 13. 主链路：一轮把三件事从 0/3 走到 3/3，中途始终只有一个进行中
  const fixed = await turn('帮我修一下失败的测试')
  const source = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  const everyTable = fixed.messages
    .flatMap((m) => m.toolCalls ?? [])
    .filter((call) => call.name === 'update_todos')
  const running = everyTable.map(
    (call) =>
      ((JSON.parse(call.args) as { items?: Array<{ status: string }> }).items ?? []).filter(
        (item) => item.status === 'in_progress'
      ).length
  )
  check(
    fixed.todos.counts.done === 3 &&
      source.includes('divide by zero') &&
      running.every((count) => count <= 1) &&
      fixed.summary.error === null,
    `一轮走完三步（${fixed.todos.counts.done}/3 已完成），每次整表替换里进行中的数量都是 ${[...new Set(running)].join('/')}`
  )

  // 14. 违规回灌纠正：一次给两个进行中，被拒之后它自己改对
  const corrected = await turn('能不能同时推进前两步')
  const rejected = corrected.summary.tools.filter((t) => t.name === 'update_todos' && !t.ok)
  check(
    rejected.length === 1 &&
      corrected.todos.counts.in_progress === 1 &&
      corrected.summary.error === null,
    `违规的那次整表替换被拒绝（${rejected.length} 次），下一轮它自己改成了只有 1 个进行中`
  )

  // 15. INJECT=loop：打转检测挡住重复调用，清单则暴露出「整件事没进展」
  const loop = loopTurn()
  check(
    loop.tools.some((t) => t.blockedBy === 'repeat') &&
      loop.nudges.length >= 1 &&
      loop.retries >= 1 &&
      loop.error !== null &&
      loop.done === 0 &&
      loop.revision === 1,
    `打转时两个机制各就各位：重复调用被挡 ${loop.tools.filter((t) => t.blockedBy === 'repeat').length} 次，` +
      `清单从写下之后一次没动（版本号 ${loop.revision}、${loop.done}/3 已完成），提醒 ${loop.nudges.length} 次后停下`
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

if (process.env.SELFTEST_CASE === 'loop-turn') {
  await reportLoopTurn()
} else {
  await main()
}
