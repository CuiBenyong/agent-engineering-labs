/**
 * 审批门。本天新增。
 *
 * 最重要的一条设计：**审批是循环里的一次暂停，不是一次异常。**
 * 具体说，门只有两种返回：
 *   null        放行，循环照常去执行工具
 *   ToolResult  不执行，把「为什么不执行」当成这次调用的结果回灌给模型
 *
 * 于是被拒绝的调用在消息数组里和「工具执行失败」长得一模一样，
 * 模型会像处理任何一次失败那样自己改道——不需要为审批发明任何新的消息类型。
 * 反过来，如果把拒绝实现成抛异常，你就得在循环外面接住它、决定要不要继续这一轮、
 * 还要补一条工具结果消息（否则下一轮请求不合法），复杂度全在错误路径上。
 */
import type { ToolCall, ToolDef, ToolResult } from './types.js'
import {
  decide,
  describeRule,
  subjectKey,
  subjectOf,
  type PermissionState,
  type Subject,
  type Verdict,
} from './permissions.js'

/** 记住这次选择的范围 */
export type Scope = 'once' | 'session' | 'config'

export interface ApprovalRequest {
  call: ToolCall
  tool: ToolDef
  subject: Subject
  verdict: Verdict
}

export interface ApprovalAnswer {
  approved: boolean
  scope: Scope
  /** 拒绝时用户补的一句话，会连同规则原因一起回灌 */
  note?: string
}

/** 审批的提问方式由调用方决定：REPL 里是问一句，自检里是按剧本回答 */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalAnswer>

export interface GateOptions {
  state: PermissionState
  approve?: Approver
  /** 把选择写到哪里（scope 为 config 时）。不传就只记在本会话 */
  persist?: (state: PermissionState) => Promise<void>
  log?: (line: string) => void
}

/**
 * 过一次门。返回 null 表示放行。
 */
export async function passGate(
  call: ToolCall,
  tool: ToolDef,
  options: GateOptions
): Promise<ToolResult | null> {
  const subject = subjectOf(tool.name, call.args)
  const verdict = decide(tool, subject, options.state)

  if (verdict.decision === 'allow') return null

  if (verdict.decision === 'deny') {
    return denied(tool, verdict.reason, verdict.rule ? describeRule(verdict.rule) : undefined)
  }

  // ask：没有提问渠道时按拒绝处理。默认放行是本课明确反对的做法——
  // 一个在无人值守环境里自动同意的门，等于没有门。
  if (!options.approve) {
    return denied(tool, '需要人工确认，但当前环境无法提问（非交互终端）', undefined)
  }

  const answer = await options.approve({ call, tool, subject, verdict })

  if (!answer.approved) {
    return denied(tool, answer.note ?? '用户拒绝了这次操作', undefined)
  }

  // 记住这次选择：本轮 / 本会话 / 写进配置
  if (answer.scope === 'once') {
    options.state.onceAllowed.add(subjectKey(subject))
  } else {
    options.state.rules.push({
      tool: tool.name,
      ...(subject.path ? { path: subject.path } : {}),
      ...(subject.command ? { command: subject.command } : {}),
      decision: 'allow',
      why: answer.scope === 'config' ? '用户批准并写入配置' : '用户在本会话内批准',
    })
    if (answer.scope === 'config' && options.persist) await options.persist(options.state)
  }
  options.log?.(`已批准 ${tool.name}（范围：${answer.scope}）`)
  return null
}

/**
 * 拒绝的结果文本要写成模型能改道的样子：说清被拒的是什么、为什么、可以换哪条路。
 * 「permission denied」这种写法只会让它原地重试一次同样的调用。
 */
function denied(tool: ToolDef, reason: string, rule?: string): ToolResult {
  const parts = [`这次 ${tool.name} 调用没有被执行：${reason}`]
  if (rule) parts.push(`（命中规则：${rule}）`)
  parts.push('请换一种不需要该权限的做法，或者向用户说明为什么必须这么做。')
  return { ok: false, content: parts.join('\n'), meta: { blockedBy: 'approval' } }
}
