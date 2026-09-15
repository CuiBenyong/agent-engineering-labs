/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十二件事，打印勾叉后按结果退出。
 *
 * 今天有一项必须**跨进程**验：INJECT 在模块加载时就读死了，同一个进程里改不了。
 * 所以父进程 spawn 一次自己（带 INJECT=dirty），子进程跑完一轮任务后把结果打成
 * 一行 RESULT，父进程解析它再断言——这个形状从第六天起一直在用。
 *
 * 其余全部离线、全部可复现：哈希是内容的函数，快照记录是纯数据，
 * 回滚的判定（stateAt / planFiles）是纯函数，四种组合比的是「文件内容」与「消息条数」。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { stdout } from 'node:process'
import { newSession } from './commands.js'
import { runTurn } from './turn.js'
import { createProvider } from './providers/index.js'
import { SessionLog, SESSIONS_DIR, readEvents } from './session/log.js'
import { forkPoints } from './session/replay.js'
import { seedRepo, REPO_DIR } from './seed.js'
import type { ApprovalAnswer } from './kernel/approval.js'
import type { Session } from './commands.js'
import { getBlob, hashOf, putBlob, storeStats, SNAPSHOT_DIR } from './snapshot/store.js'
import { CheckpointLog, readCheckpoints, stateAt, latestState } from './snapshot/log.js'
import { captureBaseline } from './snapshot/capture.js'
import { applyDirtyInjection } from './snapshot/dirty.js'
import { applyFiles, planFiles, rewindConversation } from './snapshot/rewind.js'
import { blocking, detectDrift } from './snapshot/workspace.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const CALC = path.join(REPO_DIR, 'src/calc.js')
const TASK = '修一下失败的测试，再给 divide 补一条注释'
/** 审批：今天全部放行——本天要看的是快照与回滚，不是门 */
const approve = async (): Promise<ApprovalAnswer> => ({ approved: true, scope: 'once' })

async function readCalc(): Promise<string> {
  return fs.readFile(CALC, 'utf8')
}

/** 从零开始：清掉两条时间线的落盘，重新 seed，拍基线，开一条会话 */
async function fresh(): Promise<{ session: Session; baseline: number }> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true })
  await fs.rm(SNAPSHOT_DIR, { recursive: true, force: true })
  await seedRepo()
  const checkpoints = await CheckpointLog.open()
  const baseline = await captureBaseline(checkpoints, REPO_DIR)
  const session = newSession(() => {}, await SessionLog.create(), { checkpoints })
  return { session, baseline }
}

async function runTask(session: Session, line = TASK): Promise<void> {
  await runTurn({
    session,
    provider: createProvider(),
    line,
    write: () => {},
    out: () => {},
    approve,
    tty: false,
  })
}

/** 子进程那一支：INJECT=dirty 下跑一轮任务，然后试着回滚到基线 */
async function dirtyCase(): Promise<void> {
  const { session, baseline } = await fresh()
  const injected = await applyDirtyInjection(REPO_DIR)
  await runTask(session)
  const read = await readCheckpoints()
  const drifts = await detectDrift(read.checkpoints, REPO_DIR)
  const hard = blocking(drifts)
  // 拒绝，所以什么都不做。README 里那段手写内容必须还在
  const readme = await fs.readFile(path.join(REPO_DIR, 'README.md'), 'utf8')
  out(
    `RESULT ${JSON.stringify({
      injected: injected.path,
      baseline,
      drifts: drifts.map((d) => ({ path: d.path, kind: d.kind })),
      blocked: hard.length,
      handWrittenKept: readme.includes('我自己在写的一节'),
      calcFixed: (await readCalc()).includes('divide by zero'),
    })}`
  )
}

interface DirtyReport {
  injected: string
  baseline: number
  drifts: Array<{ path: string; kind: string }>
  blocked: number
  handWrittenKept: boolean
  calcFixed: boolean
}

function spawnDirty(): DirtyReport {
  const child = spawnSync(
    process.argv[0] as string,
    [...process.execArgv, process.argv[1] as string],
    {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, MOCK: '1', SELFTEST: '1', SELFTEST_CASE: 'dirty', INJECT: 'dirty' },
    }
  )
  const line = (child.stdout ?? '').split('\n').find((row) => row.startsWith('RESULT '))
  if (!line) throw new Error(`子进程没有给出结果：${child.stderr?.slice(0, 400)}`)
  return JSON.parse(line.slice('RESULT '.length)) as DirtyReport
}

async function main(): Promise<void> {
  if (process.env.SELFTEST_CASE === 'dirty') {
    await dirtyCase()
    return
  }

  // 1. 内容寻址：同样的内容写两次只产生一份对象，哈希只认内容不认文件名
  await fs.rm(SNAPSHOT_DIR, { recursive: true, force: true })
  const first = await putBlob('export const a = 1\n')
  const again = await putBlob('export const a = 1\n')
  const other = await putBlob('export const a = 2\n')
  const twoObjects = await storeStats()
  check(
    first.fresh &&
      !again.fresh &&
      first.hash === again.hash &&
      first.hash === hashOf('export const a = 1\n') &&
      other.hash !== first.hash &&
      twoObjects.objects === 2,
    `同样内容写两次只落一份对象（${first.hash}），三次 put 之后对象库里 ${twoObjects.objects} 个对象`
  )

  // 2. 基线 + 只存被工具改过的文件：一轮任务之后，非基线记录只涉及 src/calc.js
  const one = await fresh()
  await runTask(one.session)
  const afterTask = (await readCheckpoints()).checkpoints
  const touched = new Set(afterTask.filter((c) => c.phase !== 'baseline').map((c) => c.path))
  check(
    one.baseline === 4 &&
      afterTask.filter((c) => c.phase === 'baseline').length === 4 &&
      touched.size === 1 &&
      touched.has('src/calc.js'),
    `基线拍下 ${one.baseline} 个文件；这一轮里只有 ${[...touched].join('、')} 被记了新快照（读过的、跑过测试的文件都没记）`
  )

  // 3. 写工具前后各一次，而对象库靠内容去重：四条记录只对应三份内容
  const writes = afterTask.filter((c) => c.phase !== 'baseline')
  const phases = writes.map((c) => c.phase).join(',')
  const hashes = new Set(writes.map((c) => c.hash))
  check(
    phases === 'before,after,before,after' &&
      hashes.size === 3 &&
      writes[1]?.hash === writes[2]?.hash,
    `两次 edit_file 记了 ${writes.length} 条（${phases}），但只有 ${hashes.size} 份不同内容——第一次的「改之后」就是第二次的「改之前」`
  )

  // 4. stateAt 是纯函数：回到基线那一刻，对象库里那份 calc.js 是没有除零保护的原文
  const baselineSeq = afterTask.filter((c) => c.phase === 'baseline').at(-1)?.seq ?? 0
  const atBaseline = stateAt(afterTask, baselineSeq).get('src/calc.js')
  const now = latestState(afterTask).get('src/calc.js')
  const original = atBaseline?.hash ? await getBlob(atBaseline.hash) : null
  check(
    atBaseline?.hash !== undefined &&
      atBaseline.hash !== now?.hash &&
      original !== null &&
      !original.includes('divide by zero') &&
      original.includes('return a / b'),
    `stateAt(#${baselineSeq}) 指向基线那份 calc.js（${atBaseline?.hash}，没有除零保护），与现在的 ${now?.hash} 不同`
  )

  // 5. planFiles：任务里新建的文件，回到新建之前就该被删掉，不是「还原成空」
  const created = await fresh()
  await runTask(created.session, '先出个计划，然后顺手把说明也写一下')
  const withNew = (await readCheckpoints()).checkpoints
  const backToBase = withNew.filter((c) => c.phase === 'baseline').at(-1)?.seq ?? 0
  const plan = planFiles(withNew, backToBase)
  const notes = plan.find((row) => row.path === 'src/notes.md')
  check(
    notes?.action === 'delete' &&
      notes.to === null &&
      plan.find((row) => row.path === 'src/calc.js')?.action === 'restore',
    `回到基线的计划里：src/notes.md 是删除（那一刻它还不存在），src/calc.js 是还原`
  )

  // 6. 只回文件：文件回到基线，而消息数组一条都没少
  const filesOnly = await fresh()
  await runTask(filesOnly.session)
  const messagesBefore = filesOnly.session.messages.length
  const cps = (await readCheckpoints()).checkpoints
  const base = cps.filter((c) => c.phase === 'baseline').at(-1)?.seq ?? 0
  await applyFiles(planFiles(cps, base), REPO_DIR)
  check(
    !(await readCalc()).includes('divide by zero') &&
      filesOnly.session.messages.length === messagesBefore,
    `只回文件：divide 的除零保护没了（回到基线），而对话还是 ${messagesBefore} 条消息一条没动`
  )

  // 7. 只回对话：消息数组回到某个 seq，而文件内容一个字节都没动
  const chatOnly = await fresh()
  await runTask(chatOnly.session)
  const calcKept = await readCalc()
  const points = forkPoints((await readEvents(chatOnly.session.log.id)).events)
  const target = points[0]?.seq ?? 0
  const back = await rewindConversation(chatOnly.session.log.id, target)
  check(
    back.messages.length < chatOnly.session.messages.length &&
      back.forkedFrom?.from === chatOnly.session.log.id &&
      back.forkedFrom.atSeq === target &&
      (await readCalc()) === calcKept,
    `只回对话：消息从 ${chatOnly.session.messages.length} 条回到 ${back.messages.length} 条、血缘记着来自第 ${target} 条，而 src/calc.js 一个字节都没动`
  )

  // 8. 都回：两条线各按自己那个位置回退，一次做完
  const both = await fresh()
  await runTask(both.session)
  const bothCps = (await readCheckpoints()).checkpoints
  const bothBase = bothCps.filter((c) => c.phase === 'baseline').at(-1)?.seq ?? 0
  const bothPoint = forkPoints((await readEvents(both.session.log.id)).events)[0]?.seq ?? 0
  const bothFiles = await applyFiles(planFiles(bothCps, bothBase), REPO_DIR)
  const bothChat = await rewindConversation(both.session.log.id, bothPoint)
  check(
    bothFiles.restored.includes('src/calc.js') &&
      !(await readCalc()).includes('divide by zero') &&
      bothChat.messages.length < both.session.messages.length,
    `都回：还原 ${bothFiles.restored.length} 个文件、删除 ${bothFiles.deleted.length} 个，同时对话回到 ${bothChat.messages.length} 条`
  )

  // 9. 都不回：预演算得出要做什么，但磁盘与消息一个字节都没动
  const dry = await fresh()
  await runTask(dry.session)
  const dryCalc = await readCalc()
  const dryMessages = dry.session.messages.length
  const dryCps = (await readCheckpoints()).checkpoints
  const dryPlan = planFiles(dryCps, dryCps.filter((c) => c.phase === 'baseline').at(-1)?.seq ?? 0)
  check(
    dryPlan.some((row) => row.action !== 'unchanged') &&
      (await readCalc()) === dryCalc &&
      dry.session.messages.length === dryMessages,
    `都不回（预演）：算出 ${dryPlan.filter((r) => r.action !== 'unchanged').length} 个文件要动，但磁盘与 ${dryMessages} 条消息都没变`
  )

  // 10. INJECT=dirty：工作区里有 mca 没记录过的改动时，先拒绝，而且那段手写内容还在
  const dirty = spawnDirty()
  check(
    dirty.injected === 'README.md' &&
      dirty.blocked === 1 &&
      dirty.drifts.some((d) => d.path === 'README.md' && d.kind === 'content') &&
      dirty.handWrittenKept &&
      dirty.calcFixed,
    `INJECT=dirty：${dirty.injected} 上检出 ${dirty.blocked} 处未记录的改动，回滚被拒绝、手写内容还在，而 Agent 那次修复照常完成`
  )

  // 11. 外部改动检测：内容改了又改回来，哈希一样但 mtime 更新——只警告，不拒绝
  const touchedCase = await fresh()
  await runTask(touchedCase.session)
  const cps2 = (await readCheckpoints()).checkpoints
  const content = await readCalc()
  await fs.writeFile(CALC, `${content}\n// 先加一行\n`, 'utf8')
  await fs.writeFile(CALC, content, 'utf8') // 又改回来：内容一致，时间变了
  const drifts = await detectDrift(cps2, REPO_DIR)
  check(
    drifts.length === 1 &&
      drifts[0]?.path === 'src/calc.js' &&
      drifts[0].kind === 'mtime' &&
      blocking(drifts).length === 0,
    `改了又改回来：内容与快照一致但修改时间更新，只报 ${drifts[0]?.kind} 级警告，不拦住回滚`
  )

  // 12. 快照日志的坏行处理与第七天一样：停在坏行之前，不跳过、不修补
  const good = (await readCheckpoints()).checkpoints.length
  await fs.appendFile(path.join(SNAPSHOT_DIR, 'checkpoints.jsonl'), '{"seq":999,"pa', 'utf8')
  const broken = await readCheckpoints()
  check(
    broken.checkpoints.length === good && broken.stoppedAtLine === good + 1,
    `日志最后一行写坏时，读到 ${broken.checkpoints.length} 条就停在第 ${broken.stoppedAtLine} 行（前面那些行完整可信，坏行之后不存在）`
  )

  await fs.rm(SNAPSHOT_DIR, { recursive: true, force: true })
  await seedRepo()
  out(`${passed}/${passed + failed} 通过`)
  out(
    '（全部离线可复现：哈希是内容的函数，快照记录是纯数据，回滚判定是纯函数。' +
      '第 10 项跑在子进程里，因为 INJECT 在模块加载时就读死了。' +
      '不可复现的只有记录里的 ts 与 mtimeMs——今天没有任何一项断言去比它们的绝对值）'
  )
  if (failed > 0) process.exitCode = 1
}

await main()
