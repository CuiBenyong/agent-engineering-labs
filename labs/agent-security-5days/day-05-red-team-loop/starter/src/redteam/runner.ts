import { NORMAL_TASKS } from '../core/corpus.js'
import { runAgent, attackSucceeded, taskCompleted } from '../agent/reactive.js'
import { runPlanned } from '../agent/planned.js'
import { execute } from '../runtime/executor.js'
import type { TenantContext } from '../policy/engine.js'
import { RED_TEAM_CASES, type RedTeamCase } from './cases.js'
import type { ModelAction } from '../core/mock-model.js'

const CTX: TenantContext = { tenantId: 'acme', userId: 'u-1024', allowedTenants: ['acme'] }
const PRE_AUTHORIZED = ['riskcontrol@deskmate.internal']

export interface CaseOutcome {
  id: string
  origin: RedTeamCase['origin']
  succeeded: boolean
  /** 这条用例的结果与 expected 是否一致 */
  regression: boolean
}

export interface Report {
  config: string
  /** 门禁只看被 gate 的那个配置；基线本来就该是红的，不该报回归 */
  gated: boolean
  asr: number
  utility: number
  outcomes: CaseOutcome[]
  /** 从审计日志里数出来的被拒动作总数，用于行为基线 */
  deniedActions: number
}

/** 基线：D2 那个毫无防御的版本，用来证明用例集本身是有效的。 */
function runBaseline(input: { request: string; ticketBody: string }) {
  return runAgent(0, input)
}

/** 最终形态：先定计划后执行 + 预授权收件人 + 沙箱化执行器。 */
function runHardened(input: { request: string; ticketBody: string }) {
  const planned = runPlanned(input, PRE_AUTHORIZED)
  const report = execute(planned.actions, CTX, () => true)
  return { ...planned, actions: report.executed, audit: report.audit }
}

function measure(
  config: string,
  gated: boolean,
  run: (i: { request: string; ticketBody: string }) => {
    actions: ModelAction[]
    blocked: boolean
    blockReason: string
    audit?: Array<{ decision: string }>
  }
): Report {
  const outcomes: CaseOutcome[] = []
  let deniedActions = 0

  for (const c of RED_TEAM_CASES) {
    const result = run(c)
    deniedActions += result.audit?.filter((e) => e.decision === 'deny').length ?? 0
    const succeeded = attackSucceeded(result, c)
    outcomes.push({
      id: c.id,
      origin: c.origin,
      succeeded,
      regression: gated && c.expected === 'blocked' && succeeded,
    })
  }

  let done = 0
  for (const task of NORMAL_TASKS) {
    if (taskCompleted(run(task), task)) done += 1
  }

  return {
    config,
    gated,
    asr: outcomes.filter((o) => o.succeeded).length / outcomes.length,
    utility: done / NORMAL_TASKS.length,
    outcomes,
    deniedActions,
  }
}

/** 中间形态：反应式 Agent（毫无架构防御）加上 D4 的沙箱化执行器。 */
function runExecutorOnly(input: { request: string; ticketBody: string }) {
  const reactive = runAgent(0, input)
  const report = execute(reactive.actions, CTX, () => true)
  return { ...reactive, actions: report.executed, audit: report.audit }
}

export function runRedTeam(): Report[] {
  return [
    measure('基线（无防御）', false, runBaseline),
    measure('只有执行器（D4）', false, runExecutorOnly),
    measure('最终形态（D3 加 D4）', true, runHardened),
  ]
}

export function renderReport(report: Report): string {
  const lines: string[] = []
  const open = report.outcomes.filter((o) => o.succeeded)
  lines.push(`## ${report.config}`)
  lines.push(
    `用例 ${report.outcomes.length} 条 ｜ ASR ${(report.asr * 100).toFixed(0)}% ｜ utility ${(report.utility * 100).toFixed(0)}%`
  )
  lines.push(`仍然得手：${open.length > 0 ? open.map((o) => o.id).join(' ') : '（无）'}`)
  const regressions = report.outcomes.filter((o) => o.regression)
  if (regressions.length > 0) {
    lines.push(`⚠️ 回归：${regressions.map((o) => o.id).join(' ')}（这些用例本该已经修好）`)
  }
  return lines.join('\n')
}
