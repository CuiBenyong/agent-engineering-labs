/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十二件事，打印勾叉后按结果退出。
 *
 * 今天全部离线、全部可复现：提问与回答走剧本，权限判定是纯函数，
 * 计划核对比的是「实际动过哪些文件」这种确定的事实。唯一不可复现的是耗时，
 * 而今天一个数字都不看耗时。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { stdout } from 'node:process'
import { newSession } from './commands.js'
import { runTurn } from './turn.js'
import { createProvider } from './providers/index.js'
import { SessionLog, SESSIONS_DIR } from './session/log.js'
import { seedRepo, REPO_DIR } from './seed.js'
import { createState, decide } from './kernel/permissions.js'
import type { ApprovalAnswer, ApprovalRequest } from './kernel/approval.js'
import { editFileTool } from './tools/edit-file.js'
import { readFileTool } from './tools/read-file.js'
import { runCommandTool } from './tools/command.js'
import { formatQuestion, normalizeQuestion, parseAnswer } from './plan/question.js'
import { createAskTool } from './plan/ask.js'
import { parsePlan, plannedFiles } from './plan/plan.js'
import {
  createPlanState,
  enterPlanMode,
  exitPlanMode,
  PLAN_RULES,
  type PlanState,
} from './plan/mode.js'
import { reviewPlanCall, SUBMIT_PLAN, createSubmitPlanTool } from './plan/submit.js'
import { reconcile } from './plan/check.js'
import { planApprovalAnswer } from './repl.js'
import { DEMO_PLAN } from './mock-script.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

const CTX = { cwd: REPO_DIR, signal: new AbortController().signal, log: () => {} }

/** 一次端到端跑的结果，给下面几项断言共用 */
interface Ran {
  tools: Array<{ name: string; ok: boolean; blockedBy?: string }>
  state: PlanState
  calc: string
  reconciliation: ReturnType<typeof reconcile> | null
}

/**
 * 跑一整轮：进探索模式，喂一句话，按脚本回答提问与审批。
 * `approvePlan` 决定审批那一步答 y 还是 n——今天两条支线的唯一区别就是这一位。
 */
async function runFlow(line: string, approvePlan: boolean, planMode = true): Promise<Ran> {
  await seedRepo()
  const answers = ['1'] // 提问那一步回「1」，也就是第一个选项 throw
  const session = newSession(() => {}, await SessionLog.create(), {
    ask: async () => answers.shift() ?? null,
  })
  if (planMode) enterPlanMode(session.plan, session.permissions)

  const approve = async (request: ApprovalRequest): Promise<ApprovalAnswer> =>
    request.call.name === SUBMIT_PLAN
      ? planApprovalAnswer(request, approvePlan ? 'y' : 'n')
      : { approved: true, scope: 'once' }

  const outcome = await runTurn({
    session,
    provider: createProvider(),
    line,
    write: () => {},
    out: () => {},
    approve,
    tty: false,
  })
  return {
    tools: outcome.summary.tools.map((trace) => ({
      name: trace.name,
      ok: trace.ok,
      ...(trace.blockedBy ? { blockedBy: trace.blockedBy } : {}),
    })),
    state: session.plan,
    calc: await fs.readFile(path.join(REPO_DIR, 'src/calc.js'), 'utf8'),
    reconciliation: outcome.reconciliation,
  }
}

async function main(): Promise<void> {
  await fs.rm(SESSIONS_DIR, { recursive: true, force: true })
  await seedRepo()

  // 1. 收窄而不是校验：字符串数组的 options 被收成对象，不存在的 default 被丢掉
  const loose = normalizeQuestion({
    question: '除数为 0 时怎么办？',
    options: ['throw', { value: 'null', label: '返回 null' }],
    default: '不存在的选项',
  })
  check(
    loose?.options?.length === 2 &&
      loose.options[0]?.label === 'throw' &&
      loose.default === undefined,
    `模型给的松散参数被收窄成 ${loose?.options?.length} 个选项，指向不存在选项的 default 被丢掉`
  )

  // 2. 回答的五种形状：序号、选项名、直接回车取默认、不认识的原样当答案、多选
  const question = normalizeQuestion({
    question: '除数为 0 时怎么办？',
    options: [
      { value: 'throw', label: '抛错' },
      { value: 'null', label: '返回 null' },
    ],
    default: 'throw',
  })
  const q = question as NonNullable<typeof question>
  const multi = normalizeQuestion({
    question: '改哪几处？',
    options: ['divide', 'add'],
    multi: true,
  })
  const picked = parseAnswer('1, add', multi as NonNullable<typeof multi>)
  check(
    parseAnswer('2', q).answers[0] === 'null' &&
      parseAnswer('throw', q).answers[0] === 'throw' &&
      parseAnswer('', q).answers[0] === 'throw' &&
      parseAnswer('都不是，我要返回 NaN', q).answers[0] === '都不是，我要返回 NaN' &&
      picked.answers.join(',') === 'divide,add' &&
      formatQuestion(q)[1]?.includes('1.') === true,
    `回答收五种形状：序号 2 → null、选项名、直接回车取默认 throw、不认识的原样当自由回答、多选「1, add」→ ${picked.answers.join('、')}`
  )

  // 3. 没有提问渠道时不许假装问过：明确回灌「这里问不了人」
  const muteAsk = createAskTool({})
  const muted = await muteAsk.run({ question: '除数为 0 时怎么办？' }, CTX)
  check(
    !muted.ok &&
      muted.content.includes('无法向用户提问') &&
      muted.content.includes('说明你替用户做了哪个假设'),
    '非交互环境里 ask_user 明确回灌「问不出去」并要求模型说明假设，不假装问过'
  )

  // 4. 探索模式只是换了一张规则表：只读工具直通，写工具与命令一律挡，
  //    连第五天默认放行的 node --test 也挡（不给命令开口子）
  const state = createPlanState()
  const permissions = createState()
  const before = permissions.rules.length
  enterPlanMode(state, permissions)
  const denyEdit = decide(editFileTool, { tool: 'edit_file', path: 'src/calc.js' }, permissions)
  const denyTest = decide(
    runCommandTool,
    { tool: 'run_command', command: 'node --test' },
    permissions
  )
  check(
    permissions.rules.length === PLAN_RULES.length &&
      state.savedRules?.length === before &&
      decide(readFileTool, { tool: 'read_file', path: 'src/calc.js' }, permissions).decision ===
        'allow' &&
      denyEdit.decision === 'deny' &&
      denyTest.decision === 'deny' &&
      denyEdit.reason.includes('submit_plan'),
    `进探索模式：规则表从 ${before} 条整体换成 ${permissions.rules.length} 条预设；只读工具直通、edit_file 与 node --test 都判 deny，拒绝理由里写着下一步该干什么`
  )

  // 5. 只有 submit_plan 判 ask：门会去问用户，这就是计划审批的全部接线
  const submitTool = createSubmitPlanTool({ state, permissions, writeTool: editFileTool })
  check(
    decide(submitTool, { tool: SUBMIT_PLAN }, permissions).decision === 'ask' &&
      submitTool.readOnly === false,
    'submit_plan 判 ask 且不是只读工具——审批走的是第五天那道门，没有新增任何事件类型'
  )

  // 6. 计划不可核对就不合格：缺 verify、一步都没写 files 都要退回去
  const bad = parsePlan({ goal: '让代码更好', steps: [{ action: '优化一下', files: [] }] })
  const good = parsePlan(DEMO_PLAN)
  check(
    bad.plan === null &&
      bad.problems.some((row) => row.includes('verify')) &&
      bad.problems.some((row) => row.includes('files')) &&
      good.plan?.steps.length === 2 &&
      plannedFiles(good.plan).join(',') === 'src/calc.js',
    `不可核对的计划被退回（${bad.problems.length} 条原因）；合格的那份解析出 2 步、授权范围 ${plannedFiles(good.plan as NonNullable<typeof good.plan>).join('、')}`
  )

  // 7. 预检：格式不合格的计划连问都不问出去，直接把问题清单当拒绝理由回灌
  const badCall = { id: 'c1', name: SUBMIT_PLAN, args: JSON.stringify({ goal: '让代码更好' }) }
  const review = reviewPlanCall(badCall)
  const preflight = planApprovalAnswer(
    {
      call: badCall,
      tool: submitTool,
      subject: { tool: SUBMIT_PLAN },
      verdict: { decision: 'ask', reason: '' },
    },
    'y'
  )
  check(
    review.plan === null && !preflight.approved && preflight.note?.includes('不合格') === true,
    `不完整的计划在预检就被挡下（${review.problems.length} 条原因），即使用户答了 y 也不算批准`
  )

  // 8. 批准只授权计划里那几个文件，而且不能越过 deny
  const grants = exitPlanMode(
    state,
    permissions,
    {
      goal: 'x',
      steps: [{ files: ['src/calc.js', 'test/calc.test.js'], action: 'y' }],
      verify: ['z'],
      risks: [],
    },
    editFileTool
  )
  check(
    grants.granted.join(',') === 'src/calc.js' &&
      grants.refused.join(',') === 'test/calc.test.js' &&
      decide(editFileTool, { tool: 'edit_file', path: 'src/utils.js' }, permissions).decision ===
        'ask',
    `批准后只放行 ${grants.granted.join('、')}；${grants.refused.join('、')} 本来就 deny，批准不解除它；计划外的文件仍然要单独问`
  )

  // 9. 端到端：一句话跑完提问 → 命令被挡 → 只读探索 → 交计划 → 批准 → 改文件 → 跑测试
  const flow = await runFlow('让 divide 在除数为 0 的时候更安全一点', true)
  const names = flow.tools.map((t) => t.name).join(' → ')
  check(
    names === 'ask_user → run_command → read_file → submit_plan → edit_file → run_command' &&
      flow.tools[1]?.blockedBy === 'approval' &&
      flow.tools[4]?.ok === true &&
      flow.calc.includes("throw new Error('divide by zero')"),
    `一轮六次工具调用：${names}；第二次的 run_command 被 blockedBy=approval 挡下，批准后 edit_file 真的改了 src/calc.js`
  )

  // 10. 核对表：没有偏离，验证也真的跑过
  const matched = flow.reconciliation
  check(
    matched?.matched.join(',') === 'src/calc.js' &&
      matched.unplanned.length === 0 &&
      matched.untouched.length === 0 &&
      matched.verified &&
      matched.ok,
    `核对表全对齐：计划内 ${matched?.matched.join('、')}、计划外 0 个、漏做 0 个、verify 里的 node --test 真的跑过`
  )

  // 11. 偏离的对照：多改一个计划外的文件、又没跑验证，核对表要抓到两处
  const drift = await runFlow('先出个计划，然后顺手把说明也写一下', true, false)
  const driftResult = drift.reconciliation
  check(
    driftResult?.unplanned.join(',') === 'src/notes.md' &&
      driftResult.verified === false &&
      driftResult.ok === false,
    `偏离被抓到：${driftResult?.unplanned.join('、')} 不在计划里，而且计划里写的验证方式没有跑过`
  )

  // 12. 拒绝那一支：计划没批准就还在探索模式，写工具继续被挡，文件一个字节没动
  const rejected = await runFlow('让 divide 在除数为 0 的时候更安全一点', false)
  const blocked = rejected.tools.filter((t) => t.blockedBy === 'approval').map((t) => t.name)
  check(
    rejected.state.mode === 'plan' &&
      rejected.state.approved === null &&
      rejected.state.writes.length === 0 &&
      blocked.includes('edit_file') &&
      !rejected.calc.includes('divide by zero'),
    `计划被拒之后仍在探索模式：${blocked.length} 次调用被挡（${[...new Set(blocked)].join('、')}），src/calc.js 一个字节都没动`
  )

  await seedRepo()
  out(`${passed}/${passed + failed} 通过`)
  out(
    '（全部离线可复现：提问与回答走剧本，权限判定与计划解析是纯函数，核对表比的是「实际动过哪些文件」。' +
      '第 9 与第 12 项的工具调用顺序由离线剧本钉住；接真模型时顺序会变，但每一步该被挡还是该放行不变）'
  )
  if (failed > 0) process.exitCode = 1
}

await main()
