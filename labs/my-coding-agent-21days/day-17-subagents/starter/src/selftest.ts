/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十三件事，打印勾叉后按结果退出。
 *
 * 今天全程离线、不占端口、不联网。可复现的是：白名单裁出来的工具清单、
 * 工作树里的文件内容、合并裁决、冲突条数、回执里的字段。
 * **不可复现的是耗时**——第四项断言的是「两个子 Agent 的时间区间重叠」
 * 与「墙上时间小于串行相加」，这两条是**关系**不是数值，所以在慢机器上一样成立；
 * 打印出来的那几个毫秒数只能看相对关系，不要当基准。
 */
import { stdout } from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { newSession } from './session-factory.js'
import { runTurn } from './turn.js'
import { createProvider } from './providers/index.js'
import { SessionLog } from './session/log.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { scanSkills } from './skills/scan.js'
import type { SkillState } from './skills/scan.js'
import { buildSubRegistry, runSubagent, closeWorktrees } from './agents/run.js'
import { dispatchAgents, validateSpecs, getLastDispatch } from './agents/tool.js'
import { planMerge } from './agents/merge.js'
import { listWorktrees, AGENTS_DIR } from './agents/worktree.js'
import type { SubagentResult, SubagentSpec } from './agents/spec.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const THROW_TASK = '给 src/calc.js 的 divide 加上除零保护，除数为 0 时抛 divide by zero'
const NULL_TASK = '把 src/calc.js 里 divide 的除零改成返回 null'
const DOC_TASK = '在 README.md 末尾补一段说明，写清 divide 在除数为 0 时会抛错'
const DISPATCH_LINE = '把 divide 的除零保护和 README 的说明分头做了'

const spec = (id: string, task: string, allow: string[]): SubagentSpec => ({ id, task, allow })

async function freshSession() {
  const scanned = await scanSkills()
  const state: SkillState = { ...scanned, pinned: [] }
  return newSession(() => {}, await SessionLog.create(), { skills: state })
}

/** 派一批子 Agent，但**不合并**：冲突与隔离这几项要看合并之前的样子 */
async function runOnly(specs: SubagentSpec[]): Promise<SubagentResult[]> {
  const session = await freshSession()
  const provider = createProvider()
  const settled = await Promise.all(
    specs.map((s) => runSubagent(s, { provider, parent: session.registry }))
  )
  await closeWorktrees(settled.map((s) => s.tree))
  return settled.map((s) => s.result)
}

const readRepo = (file: string) => fs.readFile(path.join(REPO_DIR, file), 'utf8')

async function main(): Promise<void> {
  // 1. 白名单：子表只装白名单里的工具，且派发工具自己永远进不去
  const base = await freshSession()
  const sub = buildSubRegistry(base.registry, [
    'read_file',
    'edit_file',
    'dispatch_agents',
    'no_such_tool',
  ])
  const names = sub.registry.list().map((t) => t.name)
  check(
    names.join(',') === 'read_file,edit_file' &&
      sub.blocked.join(',') === 'dispatch_agents' &&
      sub.unknown.join(',') === 'no_such_tool',
    `白名单：父表 ${base.registry.size} 个工具裁成 ${names.length} 个（${names.join('、')}），` +
      `dispatch_agents 被硬挡（子 Agent 不能再派子 Agent），no_such_tool 被报出来而不是静默忽略`
  )

  // 2. 派单校验：这些参数是模型编出来的，形状不对必须当场拒
  const bad = [
    validateSpecs([]).error,
    validateSpecs([{ id: 'A B', task: 'x', allow: [] }]).error,
    validateSpecs([
      { id: 'a', task: 'x', allow: [] },
      { id: 'a', task: 'y', allow: [] },
    ]).error,
    validateSpecs([{ id: 'a', task: '  ', allow: [] }]).error,
  ]
  check(
    bad.every((e) => typeof e === 'string' && e.length > 0) &&
      validateSpecs([{ id: 'calc-guard', task: 't', allow: ['read_file'] }]).error === null,
    `派单校验：空清单、非法工位号、重号、空 task 四种都被拒（「${bad[1]?.slice(0, 22)}…」），合法的放行`
  )

  // 3. 工作树隔离：子 Agent 改的是自己那份，合并之前主工作区一个字节没变
  await seedRepo()
  const before = await readRepo('src/calc.js')
  const isolated = await runOnly([spec('calc-guard', THROW_TASK, ['read_file', 'edit_file'])])
  const after = await readRepo('src/calc.js')
  check(
    before === after &&
      isolated[0]?.changes[0]?.path === 'src/calc.js' &&
      (isolated[0]?.changes[0]?.after ?? '').includes("throw new Error('divide by zero')"),
    `隔离：子 Agent 在自己工位里改出了 divide by zero，而主工作区的 src/calc.js ${before === after ? '一个字节没变' : '被改了（不该）'}`
  )

  // 4. 真并行：两个子 Agent 的时间区间重叠，且墙上时间短于串行相加
  await seedRepo()
  const parallelStart = Date.now()
  const both = await runOnly([
    spec('calc-guard', THROW_TASK, ['read_file', 'edit_file']),
    spec('doc-writer', DOC_TASK, ['read_file', 'edit_file']),
  ])
  const wallMs = Date.now() - parallelStart
  const [a, b] = both as [SubagentResult, SubagentResult]
  const overlap = Math.min(a.endedAt, b.endedAt) - Math.max(a.startedAt, b.startedAt)
  const serialMs = a.ms + b.ms
  check(
    overlap > 0 && wallMs < serialMs,
    `并行：两段区间重叠了 ${overlap}ms，墙上 ${wallMs}ms < 串行相加 ${serialMs}ms（断言的是关系不是数值）`
  )

  // 5. 结构化回收：拿回来的是回执不是对话
  check(
    both.length === 2 &&
      a.summary.includes('src/calc.js') &&
      !a.summary.includes('派单要求') &&
      a.tools.join(',') === 'edit_file' &&
      a.rounds === 1 &&
      a.tokens > 0,
    `回执：${a.id} 用过 ${a.tools.join('、')}、${a.rounds} 次调用、约 ${a.tokens} token；` +
      `回执只留了最后那段（${a.summary.length} 字符），中间那句「派单要求…」没跟回来`
  )

  // 6. 独立预算：压到 1 圈的那个被自己的上限打断，另一个照常完成
  await seedRepo()
  const budget = await runOnly([
    { ...spec('tight', THROW_TASK, ['read_file', 'edit_file']), limits: { maxRounds: 1 } },
    spec('doc-writer', DOC_TASK, ['read_file', 'edit_file']),
  ])
  const tight = budget.find((r) => r.id === 'tight')
  const roomy = budget.find((r) => r.id === 'doc-writer')
  check(
    tight?.ok === false &&
      (tight?.note ?? '').includes('轮数上限') &&
      roomy?.ok === true &&
      roomy?.changes.length === 1,
    `独立预算：tight 撞了自己的轮数上限（「${(tight?.note ?? '').slice(0, 18)}…」），doc-writer 不受连坐，照常改了 1 个文件`
  )

  // 7. 合并落盘：两个人改的是不同文件，两份都进主工作区
  await seedRepo()
  const merged = await dispatchAgents(
    [
      spec('calc-guard', THROW_TASK, ['read_file', 'edit_file']),
      spec('doc-writer', DOC_TASK, ['read_file', 'edit_file']),
    ],
    { toolsOf: () => base.registry }
  )
  const calcNow = await readRepo('src/calc.js')
  const readmeNow = await readRepo('README.md')
  check(
    merged.written.join(',') === 'README.md,src/calc.js' &&
      merged.plan.conflicts.length === 0 &&
      calcNow.includes("throw new Error('divide by zero')") &&
      readmeNow.includes('divide 的除零行为'),
    `合并：${merged.written.join(' 与 ')} 两份改动都落了盘，0 冲突`
  )

  // 8. 冲突：两个人改同一个文件成不同内容，一份都不落
  await seedRepo()
  const origin = await readRepo('src/calc.js')
  const clash = await dispatchAgents(
    [
      spec('throw-side', THROW_TASK, ['read_file', 'edit_file']),
      spec('null-side', NULL_TASK, ['read_file', 'edit_file']),
    ],
    { toolsOf: () => base.registry }
  )
  check(
    clash.plan.conflicts.length === 1 &&
      clash.plan.conflicts[0]?.path === 'src/calc.js' &&
      clash.written.length === 0 &&
      (await readRepo('src/calc.js')) === origin,
    `冲突：两边都改了 src/calc.js 且版本不同 →「${clash.plan.conflicts[0]?.why.slice(0, 30)}…」，主工作区保持原样`
  )

  // 9. 改成一样的内容不算冲突：同一件事做了两遍，落一次
  await seedRepo()
  const same = await dispatchAgents(
    [
      spec('one', THROW_TASK, ['read_file', 'edit_file']),
      spec('two', 'src/calc.js 的 divide 除数为 0 时要抛 divide by zero', [
        'read_file',
        'edit_file',
      ]),
    ],
    { toolsOf: () => base.registry }
  )
  check(
    same.plan.conflicts.length === 0 &&
      same.written.join(',') === 'src/calc.js' &&
      (same.plan.entries[0]?.why ?? '').includes('同样的内容'),
    `幂等：两个子 Agent 改出了同样的内容 →「${same.plan.entries[0]?.why}」`
  )

  // 10. 主工作区漂移：合并之前有人动过那个文件，拒绝覆盖
  const drifted = planMerge(
    [{ ...(same.results[0] as SubagentResult) }],
    new Map([['src/calc.js', '// 用户自己在编辑器里刚写的东西\n']])
  )
  check(
    drifted.conflicts.length === 1 && (drifted.conflicts[0]?.why ?? '').includes('基线已经对不上'),
    `漂移：主工作区那个文件在派发之后被改过 →「${drifted.conflicts[0]?.why}」，没有无声覆盖`
  )

  // 11. 收摊：每次派发之后工位目录里不留东西
  check(
    (await listWorktrees()).length === 0,
    `收摊：${AGENTS_DIR} 下没有残留工位（留着的话下一次跑会看到上一次的脏数据）`
  )

  // 12. 端到端：一句话 → 模型自己拆成两张派单 → 合并回主会话
  await seedRepo()
  const e2e = await freshSession()
  const turn = await runTurn({
    session: e2e,
    provider: createProvider(),
    line: DISPATCH_LINE,
    write: () => {},
    out: () => {},
    approve: async () => ({ approved: true, scope: 'once' }),
    tty: false,
  })
  const last = getLastDispatch()
  const toolMessage = e2e.messages.find((m) => m.role === 'tool' && m.name === 'dispatch_agents')
  const reported = typeof toolMessage?.content === 'string' ? toolMessage.content : ''
  check(
    turn.summary.tools.map((t) => t.name).join(',') === 'dispatch_agents' &&
      last?.results.length === 2 &&
      reported.includes('【calc-guard】') &&
      reported.includes('【doc-writer】') &&
      (await readRepo('src/calc.js')).includes("throw new Error('divide by zero')") &&
      (await readRepo('README.md')).includes('divide 的除零行为'),
    `端到端：主会话只调了一次 ${turn.summary.tools[0]?.name}，两个子 Agent 各改各的，两份改动都合并回来了`
  )

  // 13. 主会话没有被子 Agent 的对话污染
  const mainText = e2e.messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('')
  const worktreeGone = (await listWorktrees()).length === 0
  check(
    !mainText.includes('派单要求除数为 0 时抛错') &&
      !mainText.includes('我在 README.md 末尾加一节') &&
      reported.split('\n').length < 30 &&
      worktreeGone,
    `不污染：子 Agent 那几句原话一个字都没进主会话的消息数组，回灌的只有 ${reported.split('\n').length} 行结构化回执`
  )

  out(`${passed}/${passed + failed} 通过`)
  out(
    '（全部离线可复现：不联网、不占端口。第四项断言的是时间区间的**关系**' +
      '——重叠、以及并行快于串行相加——不是具体毫秒数，所以慢机器上一样成立）'
  )
  if (failed > 0) process.exitCode = 1
}

await main()
