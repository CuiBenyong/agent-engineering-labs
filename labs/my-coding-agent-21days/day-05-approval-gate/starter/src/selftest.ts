/**
 * 自检入口：不进 REPL，逐项验证今天该成立的九件事，打印勾叉后按结果退出。
 *
 * 今天的三条主线各有一项：只读直接过、写工具停下来问、被拒之后模型改道。
 * 审批的「提问」在自检里是一个按剧本回答的函数，所以整条链路仍然是真的：
 * 真的判定规则、真的暂停、真的把拒绝原因回灌进消息数组。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { newSession, parseApprovalAnswer, persistRules, RULES_FILE } from './repl.js'
import { run } from './kernel/loop.js'
import { renderTurn, type RenderSummary } from './render.js'
import { createProvider } from './providers/index.js'
import { createState, decide, subjectOf } from './kernel/permissions.js'
import { passGate } from './kernel/approval.js'
import type { ApprovalRequest, ApprovalAnswer } from './kernel/approval.js'
import { seedRepo, REPO_DIR } from './seed.js'
import type { Message } from './kernel/types.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

interface AskLog {
  tool: string
  target: string
  reason: string
}

async function ask(
  userText: string,
  answer: (request: ApprovalRequest) => ApprovalAnswer
): Promise<{ summary: RenderSummary; asked: AskLog[]; messages: Message[] }> {
  const session = newSession(() => {})
  session.messages.push({ role: 'user', content: userText })
  const asked: AskLog[] = []
  const summary = await renderTurn(
    run({
      provider: createProvider(),
      registry: session.registry,
      messages: session.messages,
      cwd: REPO_DIR,
      gate: {
        state: session.permissions,
        approve: async (request) => {
          asked.push({
            tool: request.tool.name,
            target: request.subject.path ?? request.subject.command ?? '',
            reason: request.verdict.reason,
          })
          return answer(request)
        },
      },
    }),
    () => {},
    { tty: false }
  )
  return { summary, asked, messages: session.messages }
}

async function main(): Promise<void> {
  await seedRepo()
  const registry = newSession(() => {}).registry
  const tool = (name: string) => registry.get(name)!

  // 1. 三态判定：只读放行、规则 deny、没规则命中默认 ask
  const state = createState()
  const readVerdict = decide(
    tool('read_file'),
    subjectOf('read_file', '{"path":"src/calc.js"}'),
    state
  )
  const denyVerdict = decide(
    tool('edit_file'),
    subjectOf('edit_file', '{"path":"test/calc.test.js"}'),
    state
  )
  const askVerdict = decide(
    tool('edit_file'),
    subjectOf('edit_file', '{"path":"src/calc.js"}'),
    state
  )
  check(
    readVerdict.decision === 'allow' &&
      denyVerdict.decision === 'deny' &&
      askVerdict.decision === 'ask',
    `三态判定正确：只读 allow、test/** 是 deny、src/calc.js 落到默认 ask`
  )

  // 2. 更具体的规则赢，同具体度更严格的赢
  const custom = createState([
    { tool: '*', decision: 'allow' },
    { tool: 'run_command', command: 'git commit*', decision: 'ask' },
    { tool: 'run_command', command: 'git commit --amend*', decision: 'deny', why: '改历史' },
    { tool: 'edit_file', path: 'src/**', decision: 'ask' },
    { tool: 'edit_file', path: 'src/**', decision: 'deny', why: '同具度取严' },
  ])
  const amend = decide(
    tool('run_command'),
    subjectOf('run_command', '{"command":"git commit --amend -m x"}'),
    custom
  )
  const commit = decide(
    tool('run_command'),
    subjectOf('run_command', '{"command":"git commit -m x"}'),
    custom
  )
  const tie = decide(tool('edit_file'), subjectOf('edit_file', '{"path":"src/calc.js"}'), custom)
  check(
    amend.decision === 'deny' && commit.decision === 'ask' && tie.decision === 'deny',
    '规则优先级正确：更具体的赢（amend 是 deny，commit 只是 ask），同具体度取更严格'
  )

  // 3. 只读工具一次都不问
  const readOnlyRun = await ask('看看锁文件', () => ({ approved: false, scope: 'once' }))
  const readOnlyAsks = readOnlyRun.asked.filter((a) =>
    ['glob', 'grep', 'read_file'].includes(a.tool)
  )
  check(
    readOnlyAsks.length === 0,
    `只读工具一次都没被拿去审批（本轮共问了 ${readOnlyRun.asked.length} 次）`
  )

  // 4. deny 之后模型改道，而且被拒的调用有一条回灌结果
  await seedRepo()
  const denied = await ask('帮我修一下失败的测试', () => ({ approved: true, scope: 'once' }))
  const names = denied.summary.tools.map((t) => t.name).join('→')
  const deniedResult = denied.messages.find(
    (m) => m.role === 'tool' && String(m.content).includes('测试是验收标准')
  )
  const testFile = await fs.readFile(path.join(REPO_DIR, 'test/calc.test.js'), 'utf8')
  check(
    names === 'run_command→read_file→edit_file→edit_file→run_command' &&
      deniedResult !== undefined &&
      !testFile.includes('test.skip'),
    `改测试被拒后模型改去改被测代码（${names}），测试文件一个字节都没动`
  )

  // 5. 询问后同意：写工具真的执行了，测试从红跑到绿
  const source = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  const askedTargets = denied.asked.map((a) => `${a.tool} ${a.target}`)
  check(
    source.includes('divide by zero') &&
      askedTargets.length === 1 &&
      askedTargets[0] === 'edit_file src/calc.js' &&
      denied.summary.tools.at(-1)?.ok === true,
    `写工具停下来问了 1 次（${askedTargets[0]}），批准后改动生效、测试变绿`
  )

  // 6. 询问后拒绝：文件不许被改动，而且拒绝原因回灌了
  await seedRepo()
  const refused = await ask('帮我修一下失败的测试', () => ({
    approved: false,
    scope: 'once',
    note: '这个文件我自己来改',
  }))
  const untouched = await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8')
  const refusalFed = refused.messages.some(
    (m) => m.role === 'tool' && String(m.content).includes('这个文件我自己来改')
  )
  check(
    !untouched.includes('divide by zero') && refusalFed,
    '拒绝之后文件没有被改动，拒绝原因作为工具结果回灌给了模型'
  )

  // 7. 回答解析：只有 y / a / w 算同意，看不懂的一律按拒绝
  const answerParsing =
    parseApprovalAnswer('y').scope === 'once' &&
    parseApprovalAnswer('a').scope === 'session' &&
    parseApprovalAnswer('w').scope === 'config' &&
    parseApprovalAnswer('n').approved === false &&
    parseApprovalAnswer('好的').approved === false &&
    parseApprovalAnswer(null).approved === false
  check(answerParsing, '审批回答解析正确，看不懂的回答与 EOF 都按拒绝处理')

  // 8. 三种记忆范围各自记在哪：本轮记进集合、本会话追加规则、写配置还要落盘
  const call = { id: 'c1', name: 'edit_file', args: JSON.stringify({ path: 'src/calc.js' }) }
  const counts = { once: 0, session: 0, config: 0 }
  const onceState = createState()
  const sessionState = createState()
  await fs.rm(RULES_FILE, { force: true })
  for (const state of [onceState, sessionState]) {
    const scope = state === onceState ? ('once' as const) : ('session' as const)
    for (let i = 0; i < 2; i += 1) {
      await passGate(call, tool('edit_file'), {
        state,
        approve: async () => {
          counts[scope] += 1
          return { approved: true, scope }
        },
      })
    }
  }
  const configState = createState()
  await passGate(call, tool('edit_file'), {
    state: configState,
    approve: async () => {
      counts.config += 1
      return { approved: true, scope: 'config' }
    },
    persist: persistRules,
  })
  // 读不到就当空表：starter 里 TODO(4) 还没实现时，这个文件根本不会被写出来
  const written = await fs
    .readFile(RULES_FILE, 'utf8')
    .then((text) => JSON.parse(text) as { rules: unknown[] })
    .catch(() => ({ rules: [] as unknown[] }))
  check(
    counts.once === 1 &&
      counts.session === 1 &&
      onceState.onceAllowed.size === 1 &&
      onceState.rules.length === 4 &&
      sessionState.rules.length === 5 &&
      written.rules.length === 5,
    `本轮与本会话都只问一次，本会话多了一条规则，写配置落盘 ${written.rules.length} 条`
  )

  // 9. 没有提问渠道（非交互终端、CI、别的 Agent 的 shell）时，ask 必须按拒绝处理
  const noChannel = await passGate(call, tool('edit_file'), { state: createState() })
  // 顺带确认无交互终端下 REPL 自己不会卡住：空输入直接 EOF，正常退出
  const child = spawnSync(process.argv[0], [...process.execArgv, process.argv[1]], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, SELFTEST: '', MOCK: '1' },
  })
  check(
    noChannel !== null &&
      noChannel.ok === false &&
      noChannel.content.includes('无法提问') &&
      child.status === 0,
    '没有提问渠道时 ask 按拒绝处理而不是自动放行，且 REPL 在 EOF 下正常退出'
  )

  out(`${passed}/${passed + failed} 通过`)
  if (failed > 0) process.exitCode = 1
}

await main()
