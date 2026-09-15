import 'dotenv/config'
import fs from 'node:fs/promises'

/**
 * D5 实验：双工具对比脚本。
 *
 * 读两份运行记录（JSON），归一成同一张 Markdown 对比表，并给每一行差异标注
 * 「来自工作方式还是能力」的初步判断（最终判断由你在报告模板里写）。
 *
 * 用法：
 *   MOCK=1 pnpm start                                   # 用内置样例记录
 *   pnpm start ../runs/codex.json ../runs/claude-code.json  # 用你自己填的记录
 *
 * 这个脚本不调任何模型；MOCK=1 只是用样例数据代替文件。
 */

// ---------- 运行记录的形状（与 runs/template.json 一致） ----------

export interface RunRecord {
  tool: string
  startCommit: string
  task: string
  promptChars: number
  instructionsChars: number
  approvals: { count: number; reasons: string[] }
  verification: { ranTests: boolean; testsPassed: number; testsFailed: number; fixedOnRed: boolean }
  cost: { minutes: number; inputTokens: number; outputTokens: number }
  filesChanged: number
  review: { comments: number; accepted: number }
}

/** 手写的类型守卫：JSON 是外来数据，不能直接 as */
export function isRunRecord(value: unknown): value is RunRecord {
  // 练习 1：JSON 是外来数据，不能直接 as。逐字段检查 tool / startCommit / task 是字符串，
  //         promptChars 等是数字，approvals / verification / cost / review 四个嵌套对象的字段齐全。
  //         现在无条件返回 true，一份字段写错的记录会一路漏到渲染阶段才炸。
  return typeof value === 'object' && value !== null
}

// ---------- 内置样例：MOCK=1 时代替文件（数字是一次演练的示范值，不是基准） ----------

const SAMPLE_RUNS: RunRecord[] = [
  {
    tool: 'codex',
    startCommit: 'a1b2c3d',
    task: '给 TODO API 补输入校验与单元测试',
    promptChars: 142,
    instructionsChars: 389,
    approvals: { count: 1, reasons: ['npm install zod 需要联网'] },
    verification: { ranTests: true, testsPassed: 9, testsFailed: 0, fixedOnRed: true },
    cost: { minutes: 7.5, inputTokens: 48200, outputTokens: 6100 },
    filesChanged: 3,
    review: { comments: 3, accepted: 2 },
  },
  {
    tool: 'claude-code',
    startCommit: 'a1b2c3d',
    task: '给 TODO API 补输入校验与单元测试',
    promptChars: 142,
    instructionsChars: 389,
    approvals: {
      count: 4,
      reasons: [
        '写 src/schemas/todo.ts',
        '写 test/todo.test.ts',
        '运行 pnpm test',
        '运行 pnpm test（第二次）',
      ],
    },
    verification: { ranTests: true, testsPassed: 11, testsFailed: 0, fixedOnRed: true },
    cost: { minutes: 6.8, inputTokens: 61900, outputTokens: 5400 },
    filesChanged: 4,
    review: { comments: 4, accepted: 3 },
  },
]

// ---------- 读取与校验 ----------

async function loadRuns(paths: string[]): Promise<RunRecord[]> {
  if (process.env.MOCK === '1') return SAMPLE_RUNS
  if (paths.length < 2)
    throw new Error('需要至少两份运行记录：pnpm start a.json b.json（或用 MOCK=1 看样例）')
  const runs: RunRecord[] = []
  for (const p of paths) {
    const raw: unknown = JSON.parse(await fs.readFile(p, 'utf8'))
    if (!isRunRecord(raw)) throw new Error(`${p} 不符合 runs/template.json 的字段，先对照模板补全`)
    runs.push(raw)
  }
  return runs
}

/** 可比性检查：三项不一致就别急着比 */
export function comparabilityIssues(runs: RunRecord[]): string[] {
  const issues: string[] = []
  const first = runs[0]
  if (!first) return issues
  // 练习 2：对 runs.slice(1) 里的每一份，与 first 比较 startCommit / promptChars / instructionsChars，
  //         不一致就 push 一条可读的说明。现在永远返回空数组——把 runs/claude-code.json 的
  //         startCommit 改掉再跑，你会发现脚本毫无察觉。
  void first
  return issues
}

// ---------- 渲染 ----------

function row(label: string, pick: (r: RunRecord) => string | number, runs: RunRecord[]): string {
  return `| ${label} | ${runs.map(pick).join(' | ')} |`
}

export function renderTable(runs: RunRecord[]): string {
  const header = `| 维度 | ${runs.map((r) => r.tool).join(' | ')} |`
  const sep = `| --- | ${runs.map(() => '---').join(' | ')} |`
  return [
    header,
    sep,
    row('交代：需求字数 + 说明文件字数', (r) => r.promptChars + r.instructionsChars, runs),
    row('审批：中断次数', (r) => r.approvals.count, runs),
    row('验证：自己跑了测试', (r) => (r.verification.ranTests ? '是' : '否'), runs),
    row(
      '验证：通过 / 失败',
      (r) => `${r.verification.testsPassed} / ${r.verification.testsFailed}`,
      runs
    ),
    row('验证：测试红了自己修', (r) => (r.verification.fixedOnRed ? '是' : '否'), runs),
    // 练习 3：补上「成本」三行——分钟、token 总数（输入 + 输出）、输入占比（百分数取整）。
    //         现在的表缺了整个成本维度，四个维度只剩三个。
    row('改动文件数', (r) => r.filesChanged, runs),
    row('自审：意见数 / 采纳数', (r) => `${r.review.comments} / ${r.review.accepted}`, runs),
  ].join('\n')
}

/**
 * 初步归因：哪些差异多半来自工作方式（配置能弥补），哪些才可能是能力差异。
 * 这只是提示，最终判断写在报告模板里。
 */
export function attribute(runs: RunRecord[]): string[] {
  // 练习 4：给差异做初步归因。至少覆盖：审批次数不同（多半是权限模型差异 → 工作方式）、
  //         是否主动跑测试不同（先查说明文件措辞 → 工作方式）、输入 token 占比差超过 10 个百分点
  //         （读了更多文件）、测试数量不同（可能是能力，但要多跑几次）。现在什么都不输出。
  void runs
  return []
}

async function main(): Promise<void> {
  const runs = await loadRuns(process.argv.slice(2))
  const issues = comparabilityIssues(runs)
  if (issues.length > 0) {
    console.log('⚠️ 可比性问题（先修再比）：')
    for (const i of issues) console.log(`  - ${i}`)
    console.log('')
  }
  console.log(renderTable(runs))
  console.log('')
  console.log('初步归因（把它们抄进报告模板再逐行确认）：')
  for (const n of attribute(runs)) console.log(`- ${n}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
