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
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const approvals = v.approvals as Record<string, unknown> | undefined
  const verification = v.verification as Record<string, unknown> | undefined
  const cost = v.cost as Record<string, unknown> | undefined
  const review = v.review as Record<string, unknown> | undefined
  return (
    typeof v.tool === 'string' &&
    typeof v.startCommit === 'string' &&
    typeof v.task === 'string' &&
    typeof v.promptChars === 'number' &&
    typeof v.instructionsChars === 'number' &&
    typeof approvals?.count === 'number' &&
    Array.isArray(approvals?.reasons) &&
    typeof verification?.ranTests === 'boolean' &&
    typeof verification?.testsPassed === 'number' &&
    typeof verification?.testsFailed === 'number' &&
    typeof verification?.fixedOnRed === 'boolean' &&
    typeof cost?.minutes === 'number' &&
    typeof cost?.inputTokens === 'number' &&
    typeof cost?.outputTokens === 'number' &&
    typeof v.filesChanged === 'number' &&
    typeof review?.comments === 'number' &&
    typeof review?.accepted === 'number'
  )
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
  for (const r of runs.slice(1)) {
    if (r.startCommit !== first.startCommit)
      issues.push(
        `起点 commit 不一致：${first.tool}=${first.startCommit}，${r.tool}=${r.startCommit}`
      )
    if (r.promptChars !== first.promptChars)
      issues.push(`需求字数不一致：${first.tool}=${first.promptChars}，${r.tool}=${r.promptChars}`)
    if (r.instructionsChars !== first.instructionsChars)
      issues.push(
        `说明文件字数不一致：${first.tool}=${first.instructionsChars}，${r.tool}=${r.instructionsChars}`
      )
  }
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
    row('成本：分钟', (r) => r.cost.minutes, runs),
    row('成本：token（输入 + 输出）', (r) => r.cost.inputTokens + r.cost.outputTokens, runs),
    row(
      '成本：输入占比',
      (r) =>
        `${Math.round((100 * r.cost.inputTokens) / (r.cost.inputTokens + r.cost.outputTokens))}%`,
      runs
    ),
    row('改动文件数', (r) => r.filesChanged, runs),
    row('自审：意见数 / 采纳数', (r) => `${r.review.comments} / ${r.review.accepted}`, runs),
  ].join('\n')
}

/**
 * 初步归因：哪些差异多半来自工作方式（配置能弥补），哪些才可能是能力差异。
 * 这只是提示，最终判断写在报告模板里。
 */
export function attribute(runs: RunRecord[]): string[] {
  const notes: string[] = []
  const [a, b] = runs
  if (!a || !b) return notes
  if (a.approvals.count !== b.approvals.count) {
    notes.push(
      '审批次数不同 → 多半是工作方式：两家的默认权限模型不同（沙箱内不问 vs 按工具类型逐次问），可用权限配置弥补。'
    )
  }
  if (a.verification.ranTests !== b.verification.ranTests) {
    notes.push('是否主动跑测试不同 → 先查说明文件里「改完必跑测试」的位置与措辞，多半是工作方式。')
  }
  const ratio = (r: RunRecord) => r.cost.inputTokens / (r.cost.inputTokens + r.cost.outputTokens)
  if (Math.abs(ratio(a) - ratio(b)) > 0.1) {
    notes.push(
      '输入 token 占比差距大 → 一边读了更多文件：可能更谨慎，也可能说明文件没告诉它该看哪里，先归为工作方式。'
    )
  }
  if (a.verification.testsPassed !== b.verification.testsPassed) {
    notes.push('测试数量不同 → 可能是能力差异（覆盖的边界不同），但要多跑几次确认，单次不下结论。')
  }
  return notes
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
