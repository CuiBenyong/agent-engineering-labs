/**
 * submit_plan 工具：把一份计划交给用户批准。本天新增。
 *
 * 这个工具的全部机关在于它**不是只读的**。于是第五天那道门自动接住它：
 * 计划模式的规则表里 submit_plan 判 ask，门就会调 GateOptions.approve 去问一句，
 * 用户答 y 门返回 null（工具照常执行，也就是真的切回可写模式），
 * 答 n 门返回一条 ok 为 false 的工具结果（模型看到「没有被执行」自己改道）。
 *
 * **所以计划审批没有引入任何新机制。** AgentEvent 一个事件类型都没加，
 * 渲染层一行都没改，循环一行都没改——加的只是一个工具和一条规则。
 * 这是第五天那句「审批是循环里的一次暂停，不是一次异常」的第二次分红。
 *
 * 一个必须说清的顺序问题：门排在工具执行之前，所以**用户看到计划的时候，
 * 我们还没校验过这份计划**。格式不合格的计划不该拿去打扰用户，所以校验被提前到
 * 提问那一步：reviewPlanCall 先解析一遍，解析不过就当作「用户拒绝」，
 * 把不合格的原因当拒绝理由回灌给模型让它重发一份。这是一次**预检**，
 * 不是把校验搬进了渲染层——判定还是同一份 parsePlan。
 */
import type { ToolCall, ToolDef, ToolResult } from '../kernel/types.js'
import type { PermissionState } from '../kernel/permissions.js'
import { formatPlan, parsePlan, plannedFiles, type Plan } from './plan.js'
import { exitPlanMode, type PlanState } from './mode.js'

export const SUBMIT_PLAN = 'submit_plan'

export interface PlanReview {
  plan: Plan | null
  problems: string[]
  /** 摆给用户看的几行。计划不合格时这几行是问题清单 */
  lines: string[]
}

/** 审批之前的预检：解析一次，顺手渲染。REPL 与自检共用它，判定只有这一处 */
export function reviewPlanCall(call: ToolCall): PlanReview {
  let raw: unknown
  try {
    raw = call.args.trim() === '' ? {} : JSON.parse(call.args)
  } catch {
    return { plan: null, problems: ['计划参数不是合法 JSON'], lines: ['计划参数不是合法 JSON'] }
  }
  const parsed = parsePlan(raw)
  if (!parsed.plan) {
    return {
      plan: null,
      problems: parsed.problems,
      lines: ['这份计划不完整，没有拿去打扰用户：', ...parsed.problems.map((row) => `  - ${row}`)],
    }
  }
  return { plan: parsed.plan, problems: [], lines: formatPlan(parsed.plan) }
}

export interface SubmitOptions {
  state: PlanState
  permissions: PermissionState
  /** 用来判定「计划里这个文件本来会不会被拒」的那个写工具，本课是 edit_file */
  writeTool: ToolDef
  log?: (line: string) => void
}

export function createSubmitPlanTool(options: SubmitOptions): ToolDef {
  return {
    name: SUBMIT_PLAN,
    description:
      '把一份计划交给用户批准。只读探索完成之后调它，批准之后才可以改文件、跑命令。' +
      'steps 里每一步都要写清 files（要改哪些文件）与 action（做什么）；' +
      'verify 写清怎么证明做成了；risks 写可能出错的地方。' +
      '被拒绝时不要重发同一份计划，按用户的意见改了再交。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '一句话说清这次要达成什么' },
        steps: {
          type: 'array',
          description: '每一步：files 是要改的文件（只读的步骤写空数组），action 是做什么',
          items: { type: 'object', required: ['files', 'action'] },
        },
        verify: { type: 'array', items: { type: 'string' }, description: '怎么验证做成了' },
        risks: { type: 'array', items: { type: 'string' }, description: '可能出错的地方' },
      },
      required: ['goal', 'steps', 'verify'],
      additionalProperties: false,
    },
    // 故意不是只读的：它靠第五天那道门去问用户，而门只拦非只读工具
    readOnly: false,

    async run(rawArgs: unknown): Promise<ToolResult> {
      const parsed = parsePlan(rawArgs)
      if (!parsed.plan) {
        // 正常路径下预检已经挡住了，这里是最后一道保险（有人直接放行了这个工具时）
        return { ok: false, content: `这份计划不合格：${parsed.problems.join('；')}` }
      }

      // 走到这里说明门已经放行，也就是用户批准了。切回可写模式并按计划授权
      const { granted, refused } = exitPlanMode(
        options.state,
        options.permissions,
        parsed.plan,
        options.writeTool
      )
      // 计划正文已经在审批提示里摆过一遍了，这里只报授权结果
      options.log?.(
        `已批准，切回可写模式。授权范围：${granted.length > 0 ? granted.join('、') : '（计划里没有要改的文件）'}`
      )
      if (refused.length > 0)
        options.log?.(`⚠ 计划里这几个文件仍然被规则挡着：${refused.join('、')}`)

      const parts = [
        `计划已被用户批准，现在是可写模式。这次批准的授权范围只有计划里列出的文件：${plannedFiles(parsed.plan).join('、') || '（无）'}。`,
        '请按计划逐步执行，并在结束时说明每一步的实际结果。',
        '要改计划之外的文件，先说明理由——那次写入会被单独问一遍。',
      ]
      if (refused.length > 0) {
        parts.push(
          `注意：${refused.join('、')} 被权限规则明确禁止，批准这份计划不会解除那条禁止。请改走别的路径。`
        )
      }
      return { ok: true, content: parts.join('\n'), meta: { granted, refused } }
    },
  }
}
