/**
 * 自检入口：不进 REPL，逐项验证今天该成立的十四件事，打印勾叉后按结果退出。
 *
 * 今天全程离线：五道基准题的每一步都有剧本分支，判分器跑的是沙盒仓库里那套
 * node --test，面板起在本机 3120 并在自检结束前关掉。**不需要 key、不需要网络。**
 *
 * 哪些数字可复现要先说清：通过率、轮数、token 估算、命中的判据、极差——全部可复现，
 * 同一台机器连跑两次一模一样。**耗时那一列不可复现**，所以没有任何一项断言去比它。
 * 缓存命中率在离线下恒为不可用（剧本 provider 的 cachedTokens 一直是 0），
 * 这本身就是今天要验的一件事：代码必须把「不可用」和「0%」区分开。
 */
import { stdout } from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { seedRepo, REPO_DIR } from './seed.js'
import { TASKS, findTask } from './evals/tasks.js'
import { fileUnchanged, readRepo, runTests } from './evals/grade.js'
import { runBenchmark, VARIANTS } from './evals/run.js'
import { formatReport, saveReport, spread, summarize } from './evals/report.js'
import { loadRates, isPriced, costOf, formatCost } from './evals/cost.js'
import { startPanel, PANEL_PORT } from './evals/panel.js'
import type { Attempt, RunReport } from './evals/report.js'

const out = (line: string) => stdout.write(`${line}\n`)
let passed = 0
let failed = 0

function check(ok: boolean, label: string): void {
  out(`${ok ? '✔' : '✘'} ${label}`)
  if (ok) passed += 1
  else failed += 1
}

function pick(report: RunReport, variantId: string, taskId: string): Attempt | undefined {
  return report.variants
    .find((v) => v.variantId === variantId)
    ?.attempts.find((a) => a.taskId === taskId)
}

async function main(): Promise<void> {
  // 1. 出题规矩：五道题、id 唯一、难度有梯度、至少一道负例
  const ids = new Set(TASKS.map((t) => t.id))
  const difficulties = new Set(TASKS.map((t) => t.difficulty))
  const negative = TASKS.filter((t) => t.checks.some((c) => c.label.includes('不该动手')))
  check(
    TASKS.length === 5 &&
      ids.size === 5 &&
      difficulties.size === 3 &&
      negative.length === 1 &&
      TASKS.every((t) => t.checks.length > 0 && t.intent.length > 0),
    `基准集：${TASKS.length} 道题、难度覆盖 ${[...difficulties].sort().join('/')}、其中 ${negative.length} 道负例，每道都写了出题意图`
  )

  // 2. 判分器自己跑测试，而且不是恒真：原样的仓库是红的，手动修好之后是绿的
  await seedRepo()
  const red = await runTests(REPO_DIR)
  const calcPath = path.join(REPO_DIR, 'src/calc.js')
  const raw = await fs.readFile(calcPath, 'utf8')
  await fs.writeFile(
    calcPath,
    raw.replace(
      '  return a / b\n}',
      "  if (b === 0) throw new Error('divide by zero')\n  return a / b\n}"
    ),
    'utf8'
  )
  const green = await runTests(REPO_DIR)
  check(
    !red.pass && green.pass && red.output.includes('divide by zero'),
    `判分器跑的是真测试：原样仓库红的、手动修好之后绿的（反向确认它不恒真）`
  )

  // 3. fileUnchanged 认得出一个字节的差别
  await seedRepo()
  const before = await readRepo(REPO_DIR)
  const now = new Map(before)
  now.set('src/calc.js', `${before.get('src/calc.js') ?? ''} `)
  const unchanged = fileUnchanged('src/calc.js')
  check(
    unchanged.run({
      repoDir: REPO_DIR,
      testsPass: false,
      testOutput: '',
      now: (r) => before.get(r),
      before: (r) => before.get(r),
    }) &&
      !unchanged.run({
        repoDir: REPO_DIR,
        testsPass: false,
        testOutput: '',
        now: (r) => now.get(r),
        before: (r) => before.get(r),
      }),
    '逐字节判据：内容相同判真，末尾多一个空格就判假'
  )

  // 4. 第五题的初始状态真的被摆好了：起点已经是绿的
  await seedRepo()
  const already = findTask('already-green')
  await already?.setup?.(REPO_DIR)
  const preFixed = await runTests(REPO_DIR)
  check(
    preFixed.pass && (await fs.readFile(calcPath, 'utf8')).includes('divide by zero'),
    '初始状态：第五题的 setup 把起点摆成了「已经修好」，测试一开始就是绿的'
  )

  // 5. 跑一整轮：两个变体各五道题
  const report = await runBenchmark({ repeat: 1 })
  const file = await saveReport(report)
  const baseline = report.variants.find((v) => v.variantId === 'baseline')
  check(
    baseline?.summary.passRate === 1 && baseline.summary.attempts === 5,
    `基线跑完：${baseline?.summary.passed}/${baseline?.summary.attempts} 通过，报告落在 ${path.basename(file)}`
  )

  // 6. 负例：终态是「两个文件都没被动过」，而不是「模型说它没动」
  const explain = pick(report, 'baseline', 'explain-only')
  check(
    explain?.passed === true && explain.checks.every((c) => c.ok) && explain.toolCalls === 0,
    `负例那道题：${explain?.toolCalls} 次工具调用，两个文件逐字节没动，测试仍然是红的`
  )

  // 7. 今天最关键的一条：过程里有失败，终态却达标——按终态判才判得对
  const alreadyRun = pick(report, 'baseline', 'already-green')
  check(
    alreadyRun?.passed === true && (alreadyRun?.toolFailures ?? 0) > 0,
    `终态判分：already-green 过程里有 ${alreadyRun?.toolFailures} 次工具失败，终态达标所以判通过（按过程判会判它输）`
  )

  // 8. 四类指标齐全：每道题都有轮数、token 与工具次数
  const all = report.variants.flatMap((v) => v.attempts)
  check(
    all.length === 10 &&
      all.every((a) => a.rounds > 0 && a.totalTokens > 0) &&
      all.filter((a) => a.toolCalls > 0).length === 8,
    `指标齐全：${all.length} 次尝试都有轮数与 token，其中 ${all.filter((a) => a.toolCalls > 0).length} 次真的调了工具`
  )

  // 9. token 那本账复用第六天的 LimitTracker，不是另数一遍
  check(
    all.every((a) => a.promptTokens + a.completionTokens === a.totalTokens),
    'token 口径：输入加输出逐条等于 LimitTracker 记的总数，没有第二本账'
  )

  // 10. 缓存命中率：离线 provider 不回传 cachedTokens，必须报「不可用」而不是 0.0%
  check(
    baseline?.summary.cachedTokens === 0 &&
      baseline.summary.cacheHitRate === null &&
      baseline.summary.cacheNote.includes('不回传'),
    '缓存命中率：离线下 cachedTokens 全是 0，报告标成不可用并写清两种可能，而不是打印一个 0.0%'
  )

  // 11. 单价：默认没配就是不可用；配了之后才算得出数，而且算的是「按你填的单价」
  const bare = loadRates({} as NodeJS.ProcessEnv)
  const configured = loadRates({
    LLM_PRICE_CURRENCY: '元',
    LLM_PRICE_IN: '1',
    LLM_PRICE_OUT: '2',
    LLM_PRICE_CACHED: '0.1',
  } as NodeJS.ProcessEnv)
  const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 }
  check(
    !isPriced(bare) &&
      formatCost(usage, bare).includes('不是 0') &&
      isPriced(configured) &&
      Math.abs(costOf(usage, configured) - 2.55) < 1e-9,
    `单价：没配时成本是「不可用」不是 0；按 1/2/0.1 的单价算出 ${costOf(usage, configured).toFixed(2)} 元（命中的那半按缓存价）`
  )

  // 12. A/B：同一批题、同一套判分，只改系统提示末尾那一句
  const tweaked = report.variants.find((v) => v.variantId === 'test-first')
  const delta = (tweaked?.summary.totalTokens ?? 0) - (baseline?.summary.totalTokens ?? 0)
  check(
    VARIANTS.length === 2 && tweaked?.summary.passRate === baseline?.summary.passRate && delta > 0,
    `前后对比：加一句提示词之后通过率一点没变、token 多了 ${delta}——离线 A/B 测得出成本，测不出效果`
  )

  // 13. 抖动：同一题连跑三次。离线下它应该小到可以忽略，但**不是 0**——
  //     回灌给模型的测试输出里带着 node --test 那行毫秒耗时，那几个字符就是全部的抖动来源。
  //     断言写成「小于 1%」而不是「等于 0」：写等于 0 的话这一条会在某次运行里莫名其妙变红，
  //     而真正的原因（一行耗时）完全看不出来
  const repeated = await runBenchmark({
    tasks: [TASKS[0] as (typeof TASKS)[number]],
    variants: [VARIANTS[0] as (typeof VARIANTS)[number]],
    repeat: 3,
  })
  const attempts = repeated.variants[0]?.attempts ?? []
  const jitter = spread(attempts.map((a) => a.totalTokens)) ?? 1
  check(
    jitter < 0.01 &&
      attempts.every((a) => a.rounds === attempts[0]?.rounds) &&
      summarize(attempts, loadRates()).attempts === 3,
    `抖动：同一题跑三次，轮数完全一样、token 极差只占均值 ${(jitter * 100).toFixed(2)}%` +
      `（那点抖动全部来自回灌的测试输出里那行 duration_ms）`
  )

  // 14. 面板：起在 3120，两条路由都通，然后关掉不留孤儿进程
  const panel = await startPanel()
  const api = (await (await fetch(`http://127.0.0.1:${PANEL_PORT}/api/runs`)).json()) as {
    runs: string[]
    latest: RunReport | null
  }
  const page = await (await fetch(panel.url)).text()
  await panel.close()
  check(
    api.runs.length >= 1 &&
      api.latest?.runId === report.runId &&
      api.latest?.variants.length === 2 &&
      page.includes('mca 评估面板') &&
      page.includes('/api/runs'),
    `面板：3120 上 /api/runs 返回 ${api.runs.length} 份报告、/ 返回静态页，用完已关闭`
  )

  for (const line of formatReport(report)) out(line)
  out(`${passed}/${passed + failed} 通过`)
  out(
    '（可复现：通过率、轮数、token 估算、判据结果、极差；不可复现：耗时。' +
      '缓存命中率在离线下恒为不可用，因为剧本 provider 不回传 cachedTokens。' +
      '成本一列取决于你自己填的单价，没配就是不可用。）'
  )
  if (failed > 0) process.exitCode = 1
}

await main()
