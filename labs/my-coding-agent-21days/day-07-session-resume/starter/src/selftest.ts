/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十一件事，打印勾叉后按结果退出。
 *
 * 今天的关键一项——恢复——必须**跨进程**验，所以父进程 spawn 两个子进程：
 * 第一个开新会话查明一个事实，第二个带 --resume 接着干。同一个进程里重放一遍
 * 什么都证明不了（消息数组本来就还在内存里）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { newSession, replaceHistory } from './commands.js'
import { openSession } from './repl.js'
import { parseArgv } from './cli.js'
import { run } from './kernel/loop.js'
import { renderTurn } from './render.js'
import { createProvider } from './providers/index.js'
import { recordTurn } from './session/record.js'
import { replay, forkPoints } from './session/replay.js'
import {
  SessionLog,
  SESSIONS_DIR,
  forkSession,
  listSessions,
  newSessionId,
  readEvents,
  sessionPath,
} from './session/log.js'
import { seedRepo, REPO_DIR } from './seed.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

/** 子进程模式：跑一轮（可选接上一条会话），把结果压成一行 JSON */
async function reportOneTurn(): Promise<void> {
  const session = await openSession(() => {}, parseArgv(process.argv.slice(2)))
  session.messages.push({ role: 'user', content: process.env.TURN_TEXT ?? '跑测试看看' })
  const summary = await renderTurn(
    recordTurn(
      session.log,
      session.messages,
      run({
        provider: createProvider(),
        registry: session.registry,
        messages: session.messages,
        cwd: REPO_DIR,
        gate: {
          state: session.permissions,
          approve: async () => ({ approved: true, scope: 'once' }),
        },
      })
    ),
    () => {},
    { tty: false }
  )
  out(
    `RESULT ${JSON.stringify({
      sessionId: session.log.id,
      text: summary.text,
      messages: session.messages.length,
      tools: summary.tools.length,
    })}`
  )
}

interface TurnReport {
  sessionId: string
  text: string
  messages: number
  tools: number
}

function childTurn(text: string, extraArgs: string[] = []): TurnReport {
  const child = spawnSync(
    process.argv[0] as string,
    [...process.execArgv, process.argv[1] as string, ...extraArgs],
    {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, MOCK: '1', SELFTEST: '1', SELFTEST_CASE: 'one-turn', TURN_TEXT: text },
    }
  )
  const line = (child.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '))
  if (!line) throw new Error(`子进程没有结果：${child.stderr?.slice(0, 400)}`)
  return JSON.parse(line.slice('RESULT '.length)) as TurnReport
}

async function main(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true })
  await seedRepo()

  // 1. 会话 id 的形状，以及「按 id 排序就是按时间排序」
  const early = newSessionId(new Date('2026-09-07T10:00:00.000Z'))
  const late = newSessionId(new Date('2026-09-07T10:00:01.000Z'))
  check(
    /^s-\d{8}-\d{6}-[a-z0-9]{4}$/.test(early) && early < late,
    `会话 id 形如 ${early.slice(0, 17)}xxxx，且字典序等于时间序`
  )

  // 2. 第一轮：事件逐行落盘，seq 连续，message 条数等于消息数组长度
  const first = childTurn('跑测试看看哪个用例失败了')
  const afterFirst = await readEvents(first.sessionId)
  const seqs = afterFirst.events.map((e) => e.seq)
  const messageEvents = afterFirst.events.filter((e) => e.type === 'message')
  // 顺序也要对：tool_end 必须夹在「请求它的助手消息」与「它的工具结果消息」之间。
  // 边跑边落盘才有这个顺序；攒到一轮结束再写，日志会变成「先事件后消息」
  const toolEndAt = afterFirst.events.findIndex((e) => e.type === 'tool_end')
  const before = afterFirst.events[toolEndAt - 1]
  const after = afterFirst.events[toolEndAt + 1]
  const wellOrdered =
    before?.type === 'message' &&
    before.message.role === 'assistant' &&
    after?.type === 'message' &&
    after.message.role === 'tool'
  check(
    afterFirst.stoppedAtLine === null &&
      seqs.join(',') === seqs.map((_, i) => i + 1).join(',') &&
      messageEvents.length === first.messages &&
      wellOrdered &&
      afterFirst.events.some((e) => e.type === 'usage'),
    `第一轮落盘 ${afterFirst.events.length} 条事件，seq 从 1 连续，其中 ${messageEvents.length} 条是消息事件，且 tool_end 夹在助手消息与工具结果之间`
  )

  // 3. 只有 message 参与重建；tool_end 与 usage 只用于展示与审计
  const replayed = replay(afterFirst.events)
  check(
    replayed.messages.length === first.messages &&
      replayed.skipped === afterFirst.events.length - replayed.replayed &&
      replayed.skipped > 0 &&
      replayed.tokens > 0,
    `重放出 ${replayed.replayed} 条消息，另外 ${replayed.skipped} 条事件不参与重建（累计 ${replayed.tokens} token）`
  )

  // 4. 跨进程恢复：第二个进程接着上一条会话，引用了上一轮查到的事实并把代码修好
  const contentAfterFirst = await fs.readFile(sessionPath(first.sessionId), 'utf8')
  const second = childTurn('那把它修掉', ['--resume', first.sessionId])
  const afterSecond = await readEvents(first.sessionId)
  const source = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  check(
    second.sessionId === first.sessionId &&
      second.messages > first.messages &&
      afterSecond.events.length > afterFirst.events.length &&
      second.text.includes('上一轮') &&
      source.includes('divide by zero'),
    `重启后接着干：同一条会话涨到 ${afterSecond.events.length} 条事件，第二轮引用了上一轮的发现并把代码修好`
  )

  // 5. 只追加：第二轮写入之后，第一轮那些字节逐字节还在原位
  const whole = await fs.readFile(sessionPath(first.sessionId), 'utf8')
  check(
    whole.startsWith(contentAfterFirst) &&
      whole.length > contentAfterFirst.length &&
      whole.endsWith('\n'),
    `追加写没有动过已有内容（前 ${contentAfterFirst.length} 字节逐字节不变，文件涨到 ${whole.length} 字节）`
  )

  // 6. 最后一行写坏（进程写到一半被杀）：停在前一条完整事件
  const brokenId = `${first.sessionId}-broken`
  const lines = whole.split('\n').filter(Boolean)
  const halfLast = (lines.at(-1) as string).slice(0, 20)
  await fs.writeFile(sessionPath(brokenId), `${lines.slice(0, -1).join('\n')}\n${halfLast}`, 'utf8')
  const brokenRead = await readEvents(brokenId)
  check(
    brokenRead.events.length === lines.length - 1 &&
      brokenRead.stoppedAtLine === lines.length &&
      replay(brokenRead.events).messages.length > 0,
    `最后一行写坏时停在第 ${brokenRead.stoppedAtLine} 行之前，仍然重放出 ${brokenRead.events.length} 条完整事件`
  )

  // 7. 中间行坏：一样停在坏行之前，不跳过、不修补
  const midId = `${first.sessionId}-mid`
  const midLines = [...lines]
  midLines[2] = '{"seq":3,"ts":"x","type":'
  await fs.writeFile(sessionPath(midId), `${midLines.join('\n')}\n`, 'utf8')
  const midRead = await readEvents(midId)
  check(
    midRead.events.length === 2 && midRead.stoppedAtLine === 3,
    '中间行坏掉时也停在坏行之前（读到 2 条），不跳过、不猜'
  )

  // 8. 分叉点只挑干净的边界：带工具调用的助手消息与工具结果都不算
  const points = forkPoints(afterSecond.events)
  const badPoint = afterSecond.events.some(
    (e) =>
      e.type === 'message' &&
      (e.message.role === 'tool' || (e.message.toolCalls?.length ?? 0) > 0) &&
      points.some((p) => p.seq === e.seq)
  )
  check(
    points.length >= 2 && !badPoint,
    `可分叉的位置有 ${points.length} 个，且都是干净边界（带工具调用的助手消息与工具结果都被排除）`
  )

  // 9. 分叉：复制到新文件并记一条 fork 事件，母会话一个字节都没动
  const at = points[1]?.seq as number
  const beforeFork = await fs.readFile(sessionPath(first.sessionId), 'utf8')
  const { log: forked, copied } = await forkSession(first.sessionId, at)
  const forkedRead = await readEvents(forked.id)
  const motherAfter = await fs.readFile(sessionPath(first.sessionId), 'utf8')
  const lineage = replay(forkedRead.events).forkedFrom
  check(
    forkedRead.events.length === copied + 1 &&
      forkedRead.events.at(-1)?.type === 'fork' &&
      lineage?.from === first.sessionId &&
      lineage.atSeq === at &&
      motherAfter === beforeFork,
    `从第 ${at} 条分叉出新会话（复制 ${copied} 条 + 1 条 fork 记录），母会话字节数不变`
  )

  // 10. 分叉之后两条会话各自演化，互不影响
  const forkedTurn = childTurn('再修一次试试', ['--resume', forked.id])
  const forkedAfter = await readEvents(forked.id)
  const motherFinal = await fs.readFile(sessionPath(first.sessionId), 'utf8')
  const infos = await listSessions()
  check(
    forkedTurn.sessionId === forked.id &&
      forkedAfter.events.length > forkedRead.events.length &&
      motherFinal === beforeFork &&
      infos[0]?.id ===
        (infos
          .map((i) => i.id)
          .sort()
          .at(-1) as string) &&
      infos.some((i) => i.broken),
    `分叉会话独立涨到 ${forkedAfter.events.length} 条事件，母会话仍然纹丝不动；会话列表最近的在前，坏掉的被标了出来`
  )

  // 顺手确认 newSession 与原地替换历史都还能用（分叉命令依赖它）
  const probe = newSession(() => {}, await SessionLog.create())
  const original = probe.messages
  replaceHistory(probe.messages, [{ role: 'system', content: 'x' }])
  check(
    probe.messages === original && probe.messages.length === 1,
    '替换历史是原地改数组，循环持有的引用不会失效'
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

if (process.env.SELFTEST_CASE === 'one-turn') {
  await reportOneTurn()
} else {
  await main()
}
