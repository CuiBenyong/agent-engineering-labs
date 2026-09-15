/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十四件事，打印勾叉后按结果退出。
 *
 * 今天有两类数字，正文与 README 里都声明过：
 *   **可复现**：钩子选中了几个、拦没拦下、文件内容变没变、任务状态、进度步数、
 *               通知有没有攒住、端到端那一轮调了哪几个工具。
 *   **不可复现**：钩子的毫秒数（跑一次 node --test 的真实耗时，每台机器不一样）。
 *               所以凡是和耗时有关的断言都只断言「大于 0」与「小于上限」，
 *               不断言具体值——这一条是第十天与第十二天踩过的坑。
 *
 * 端口 3118 在这里真的起一个服务端（后台任务要把进度报回来），跑完必须关掉：
 * 一个没关的监听器会让下一次自检拿到「端口被占」那条降级路径，而那条路径是绿的，
 * 于是你会得到一个「测过了」的假结论。
 */
import { stdout } from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { newSession, localTaskState, type TaskState } from './session-factory.js'
import { runTurn } from './turn.js'
import { createProvider } from './providers/index.js'
import { SessionLog } from './session/log.js'
import { seedRepo, REPO_DIR } from './seed.js'
import type { ToolCall, ToolContext } from './kernel/types.js'
import { selectHooks, runHooks } from './hooks/run.js'
import { createHookState, withHooks, runLifecycle } from './hooks/wrap.js'
import {
  defaultHooks,
  createReadBeforeWrite,
  formatAfterWrite,
  testAfterWrite,
} from './hooks/builtin.js'
import type { HookDef } from './hooks/types.js'
import { createRegistry } from './session-factory.js'
import { createState } from './kernel/permissions.js'
import { createPlanState } from './plan/mode.js'
import { startProgressServer } from './tasks/server.js'
import { NoticeQueue } from './tasks/notify.js'
import { TaskManager, TASKS_DIR } from './tasks/manager.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const ctx: ToolContext = { cwd: REPO_DIR, signal: new AbortController().signal, log: () => {} }

/** 等一个条件成立。轮询而不是 sleep 一个固定时长：固定时长在慢机器上必然偶发红 */
async function until(ok: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return ok()
}

/** 造一张挂了钩子的注册表，直接拿来跑工具调用（不经过循环，断言更干净） */
function hookedRegistry(hooks: HookDef[], sink: string[]) {
  const state = createHookState((line) => sink.push(line), hooks)
  const tasks = localTaskState()
  const registry = withHooks(createRegistry(createPlanState(), createState(), { tasks }), state)
  return { registry, state }
}

async function main(): Promise<void> {
  await seedRepo()

  // 1. 选中：按事件与工具名过滤，选错了后面全是假绿
  const all = defaultHooks(localTaskState().manager)
  const pre = selectHooks(all, 'pre_tool', 'edit_file')
  const preOnRead = selectHooks(all, 'pre_tool', 'read_file')
  const start = selectHooks(all, 'session_start')
  check(
    pre.length === 1 &&
      pre[0]?.name === 'read-before-write' &&
      preOnRead.length === 0 &&
      start.length === 1,
    `选中：edit_file 的 pre_tool 只有 ${pre[0]?.name}；read_file 的 pre_tool 一个都没有；session_start 有 ${start.length} 个`
  )

  // 2. 超时按失败处理，而且不会把调用方卡住
  const slow: HookDef = {
    name: 'slow',
    event: 'pre_tool',
    blocking: true,
    timeoutMs: 30,
    run: () =>
      new Promise((resolve) => setTimeout(() => resolve({ ok: true, note: '太晚了' }), 800)),
  }
  const timedOut = await runHooks([slow], { event: 'pre_tool', cwd: REPO_DIR })
  check(
    timedOut.denied !== null && timedOut.denied.includes('超时') && timedOut.totalMs < 2000,
    `超时：${timedOut.totalMs}ms 就返回了，判成失败并阻断（${timedOut.denied}）`
  )

  // 3. 钩子抛异常被兜住，不会炸穿循环
  const boom: HookDef = {
    name: 'boom',
    event: 'post_tool',
    blocking: false,
    timeoutMs: 500,
    run: async () => {
      throw new Error('我坏了')
    },
  }
  // 这一项要兜一层：没写超时与异常处理的实现会让 runHooks 直接把异常抛出来，
  // 而**自检本身绝不许崩**——崩了就看不到后面十一项，等于一次验收只验了两项
  const caught = await runHooks([boom], { event: 'post_tool', cwd: REPO_DIR }).catch(
    (error: unknown) => ({
      items: [
        {
          hook: boom,
          outcome: { ok: false, note: `异常没被兜住，直接抛了出来：${String(error)}` },
          ms: 0,
        },
      ],
      denied: null,
      feed: [],
      totalMs: 0,
    })
  )
  check(
    caught.items[0]?.outcome.ok === false &&
      (caught.items[0]?.outcome.note ?? '').includes('钩子抛异常') &&
      caught.denied === null,
    `异常：兜住了并记成「${caught.items[0]?.outcome.note}」，而且因为它不阻断，没有拦住任何东西`
  )

  // 4. 否决：没读过就改，被拦下，而且文件**真的没被改**
  const sink: string[] = []
  const hooked = hookedRegistry(createReadBeforeWrite(), sink)
  const calcFile = path.join(REPO_DIR, 'src/calc.js')
  const before = await fs.readFile(calcFile, 'utf8')
  const blind: ToolCall = {
    id: 'c1',
    name: 'edit_file',
    args: JSON.stringify({
      path: 'src/calc.js',
      old_string: 'return a / b',
      new_string: 'return 0',
    }),
  }
  const denied = await hooked.registry.execute(blind, ctx)
  const unchanged = (await fs.readFile(calcFile, 'utf8')) === before
  check(
    !denied.ok && denied.meta?.blockedBy === 'hook' && unchanged,
    `否决：没 read_file 过就 edit_file，被 read-before-write 拦下（blockedBy=${String(denied.meta?.blockedBy)}），文件一个字节都没变`
  )

  // 5. 放行：先读一次，同一个守卫就放行了——判据依赖会话状态，权限规则表达不了这种事
  await hooked.registry.execute(
    { id: 'c2', name: 'read_file', args: JSON.stringify({ path: 'src/calc.js' }) },
    ctx
  )
  const allowed = await hooked.registry.execute({ ...blind, id: 'c3' }, ctx)
  check(
    allowed.ok && (await fs.readFile(calcFile, 'utf8')) !== before,
    `放行：补一次 read_file 之后同一个调用就过了（${allowed.content.slice(0, 24)}…）`
  )

  // 6. 不阻断的钩子失败了只警告，不改这次调用的成败
  const warnOnly: HookDef = { ...boom, name: 'warn-only' }
  const warned = hookedRegistry([warnOnly], sink)
  await seedRepo()
  const stillOk = await warned.registry.execute(
    { id: 'c3', name: 'read_file', args: JSON.stringify({ path: 'src/calc.js' }) },
    ctx
  )
  check(
    stillOk.ok,
    '只警告：post_tool 钩子自己炸了，但因为 blocking 是 false，这次调用仍然是成功的'
  )

  // 7. 阻断型 post_tool 钩子失败 → 这次调用被判成失败，且原因回灌进了 content
  await seedRepo()
  const blocking = hookedRegistry([testAfterWrite], sink)
  const broke = await blocking.registry.execute(
    {
      id: 'c4',
      name: 'edit_file',
      args: JSON.stringify({
        path: 'src/calc.js',
        old_string: 'export function add(a, b) {',
        new_string: 'export function add(a, b) { throw new Error(1)',
      }),
    },
    ctx
  )
  check(
    !broke.ok && broke.content.includes('钩子结果：') && broke.content.includes('仍然有用例失败'),
    '阻断：改坏源码之后 test-after-write 把这次 edit_file 判成失败，测试输出原样回灌给模型'
  )

  // 8. 格式化钩子真的改了文件（写进去带尾随空格，钩子把它清掉）
  await seedRepo()
  const formatter = hookedRegistry([formatAfterWrite], sink)
  await formatter.registry.execute(
    {
      id: 'c5',
      name: 'create_file',
      args: JSON.stringify({ path: 'src/messy.js', content: 'export const a = 1   \n\n\n' }),
    },
    ctx
  )
  const cleaned = await fs.readFile(path.join(REPO_DIR, 'src/messy.js'), 'utf8')
  check(
    cleaned === 'export const a = 1\n',
    `格式化：写进去的是带尾随空格与三个空行的版本，落盘之后是 ${JSON.stringify(cleaned)}`
  )

  // 9. 耗时被记下来。**只断言区间不断言具体值**：跑一次真实测试的耗时每台机器都不同
  const timed = await runHooks([testAfterWrite], {
    event: 'post_tool',
    tool: 'edit_file',
    args: { path: 'src/calc.js' },
    result: { ok: true, content: '' },
    cwd: REPO_DIR,
  })
  check(
    timed.totalMs > 0 &&
      timed.totalMs < 20_000 &&
      timed.items[0]?.outcome.ok === false &&
      (timed.items[0]?.outcome.feed ?? '').includes('仍然有用例失败'),
    `成本可见：沙盒刚重新生成、那个用例还是红的，跑一次 test-after-write 花了 ${timed.totalMs}ms（这个数不可复现，只看量级）`
  )

  // 10. 后台任务：start 立刻返回，那一刻它还在跑
  const server = await startProgressServer(sharedTasks.manager)
  if (!server)
    throw new Error('端口 3118 被占用，自检没法验进度那一项；换 MCA_TASK_PORT 或先腾出端口')
  const task = sharedTasks.manager.start('node ../../src/tasks/worker.mjs')
  check(
    task.status === 'running' && task.exitCode === null && task.id === 't1',
    `受理回执：${task.id} 立刻返回，此刻状态是 ${task.status}、退出码还是空的——它才刚开始跑`
  )

  // 11. 进度经 3118 回来了（这一项证明那个端口真的通）
  const gotProgress = await until(() => (sharedTasks.manager.get('t1')?.progress?.step ?? 0) >= 3)
  const progress = sharedTasks.manager.get('t1')?.progress
  check(
    gotProgress && progress?.total === 3,
    `进度：任务自己把 ${progress?.step ?? 0}/${progress?.total ?? 0} 报到了 http://127.0.0.1:${server.port}/progress（${progress?.note ?? ''}）`
  )

  // 12. 完成之后日志落盘可回看
  const done = await until(() => sharedTasks.manager.get('t1')?.status === 'done')
  const tail = await sharedTasks.manager.tail('t1')
  check(
    done && tail.some((line) => line.includes('全部做完')) && tail.length >= 4,
    `日志：任务结束后 ${path.relative(process.cwd(), TASKS_DIR)}/t1.log 里有 ${tail.length} 行，最后一行是「${tail.at(-1) ?? ''}」`
  )

  // 13. 通知**攒住了而不是当场打印**（没有 REPL 接管时 canInterrupt 不成立）
  const queued = sharedTasks.notices.size
  const printed: string[] = []
  const flushed = sharedTasks.notices.flush((line) => printed.push(line))
  check(
    queued === 1 && flushed === 1 && (printed[0] ?? '').includes('t1 完成'),
    `通知：任务结束时没有当场插话，而是攒在队列里（${queued} 条），安全时刻倒出来「${(printed[0] ?? '').slice(0, 34)}…」`
  )

  // 14. 端到端：一整轮里，改测试被拦、改源码通过、模型因为读到回灌没再跑一遍测试
  await seedRepo()
  const session = newSession(() => {}, await SessionLog.create(), { tasks: sharedTasks })
  await runLifecycle(session.hooks, 'session_start', REPO_DIR)
  const turn = await runTurn({
    session,
    provider: createProvider(),
    line: '这个失败的用例，最快的办法是什么（钩子演示）',
    write: () => {},
    out: () => {},
    approve: async () => ({ approved: true, scope: 'once' }),
    tty: false,
  })
  const traces = turn.summary.tools
  const fixed = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  check(
    traces.map((t) => t.name).join(',') === 'edit_file,read_file,edit_file' &&
      traces[0]?.blockedBy === 'hook' &&
      traces[2]?.ok === true &&
      fixed.includes("throw new Error('divide by zero')") &&
      !traces.some((t) => t.name === 'run_command'),
    `端到端：第一手凭记忆改被钩子拦下（${traces[0]?.blockedBy}），补读一次之后改成了；` +
      `而且模型没有再调 run_command——钩子替它跑过测试并把结果回灌了`
  )

  await server.close()
  sharedTasks.manager.shutdown()

  out(`${passed}/${passed + failed} 通过`)
  out(
    '（可复现：选中数、拦没拦、文件内容、任务状态、进度步数、通知条数、端到端调了哪几个工具。' +
      '不可复现：上面那几个毫秒数——它们是真的在跑 node --test，每台机器都不一样。）'
  )
  if (failed > 0) process.exitCode = 1
}

/** 整个自检共用一张任务表：第 10 到 13 项讲的是同一个任务的一生 */
const sharedTasks: TaskState = (() => {
  const notices = new NoticeQueue()
  return {
    manager: new TaskManager(notices, REPO_DIR, {
      MCA_TASK_PORT: process.env.MCA_TASK_PORT ?? '3118',
    }),
    notices,
  }
})()

await main()
