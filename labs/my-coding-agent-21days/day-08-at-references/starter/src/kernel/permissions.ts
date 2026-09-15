/**
 * 权限规则表与匹配。本天新增。
 *
 * 三态而不是两态：
 *   allow  自己做，不打扰人
 *   ask    停下来问一句
 *   deny   不许做，而且不要再问（问了也不该同意）
 * 只有 allow 与 deny 的系统会走向两个极端：要么把人问烦（于是他一路按同意，等于没有门），
 * 要么把规则放宽（于是门是虚的）。ask 是给「这件事要看情况」留的位置。
 *
 * 匹配三类条件：工具名、路径模式、命令前缀。优先级只有一条规则——
 * **更具体的规则赢**；具体度相同时，更严格的赢（deny 胜 ask 胜 allow）。
 * 这条设计让规则表可以随便追加：新规则更具体就自然生效，不需要排序，
 * 也不会出现「我加了一条却被上面某条吃掉」的困惑。
 */
import type { ToolDef } from './types.js'
import { globToRegExp } from '../tools/fs.js'

export type Decision = 'allow' | 'ask' | 'deny'

export interface Rule {
  /** 工具名，缺省或 * 表示所有工具 */
  tool?: string
  /** 路径模式，只对带 path 参数的工具有意义 */
  path?: string
  /** 命令前缀模式，只对 run_command 有意义 */
  command?: string
  decision: Decision
  /** 为什么。deny 时这句话会被回灌给模型，所以要写成它能改道的样子 */
  why?: string
}

/** 默认规则表。它是本课的示例口径，不是什么行业标准 */
export const DEFAULT_RULES: Rule[] = [
  {
    tool: 'run_command',
    command: 'node --test*',
    decision: 'allow',
    why: '跑测试是只读的验证动作',
  },
  { tool: 'run_command', command: 'git status*', decision: 'allow' },
  {
    tool: 'edit_file',
    path: 'test/**',
    decision: 'deny',
    why: '测试是验收标准，不能靠改测试让它变绿。请改被测代码。',
  },
  {
    tool: 'edit_file',
    path: '**/*lock*',
    decision: 'deny',
    why: '锁文件应当由包管理器生成，不要手改。',
  },
]

export interface PermissionState {
  rules: Rule[]
  /** 本轮内一次性放行的键，轮结束就清空 */
  onceAllowed: Set<string>
}

export function createState(rules: Rule[] = DEFAULT_RULES): PermissionState {
  return { rules: [...rules], onceAllowed: new Set() }
}

/** 一次调用要被判定的「对象」：工具名加上它要动的东西 */
export interface Subject {
  tool: string
  path?: string
  command?: string
}

/** 从工具参数里取出要判定的对象。参数解析失败时只按工具名判 */
export function subjectOf(toolName: string, args: string): Subject {
  try {
    const parsed = JSON.parse(args || '{}') as Record<string, unknown>
    return {
      tool: toolName,
      path: typeof parsed.path === 'string' ? parsed.path : undefined,
      command: typeof parsed.command === 'string' ? parsed.command : undefined,
    }
  } catch {
    return { tool: toolName }
  }
}

/** 同一个对象的稳定键，用来记「本轮已经放行过」 */
export function subjectKey(subject: Subject): string {
  return `${subject.tool}:${subject.path ?? subject.command ?? ''}`
}

function matches(rule: Rule, subject: Subject): boolean {
  if (rule.tool && rule.tool !== '*' && rule.tool !== subject.tool) return false
  if (rule.path) {
    if (subject.path === undefined) return false
    if (!globToRegExp(rule.path).test(subject.path)) return false
  }
  if (rule.command) {
    if (subject.command === undefined) return false
    if (!globToRegExp(rule.command).test(subject.command)) return false
  }
  return true
}

/** 条件越多、越不含通配符，就越具体 */
function specificity(rule: Rule): number {
  let score = 0
  if (rule.tool && rule.tool !== '*') score += 2
  if (rule.path) score += rule.path.includes('*') ? 2 : 3
  if (rule.command) score += rule.command.includes('*') ? 2 : 3
  return score
}

const STRICTNESS: Record<Decision, number> = { deny: 3, ask: 2, allow: 1 }

export interface Verdict {
  decision: Decision
  reason: string
  rule?: Rule
}

/**
 * 判定一次调用。三条口径：
 *   1. 只读工具默认放行——这就是 D3 定下的 readOnly 字段的用处
 *   2. 写工具没有任何规则命中时默认 ask，不是默认 allow
 *      （默认放行的门等于没有门，而且这个错误只会在出事那天暴露）
 *   3. 命中多条时更具体的赢，同具体度更严格的赢
 */
export function decide(tool: ToolDef, subject: Subject, state: PermissionState): Verdict {
  if (tool.readOnly) return { decision: 'allow', reason: '只读工具默认放行' }
  if (state.onceAllowed.has(subjectKey(subject))) {
    return { decision: 'allow', reason: '本轮已经批准过同样的操作' }
  }

  const hits = state.rules.filter((rule) => matches(rule, subject))
  if (hits.length === 0) {
    return { decision: 'ask', reason: '没有命中任何规则，写操作默认需要确认' }
  }

  const winner = hits.reduce((best, rule) => {
    const bySpec = specificity(rule) - specificity(best)
    if (bySpec !== 0) return bySpec > 0 ? rule : best
    return STRICTNESS[rule.decision] > STRICTNESS[best.decision] ? rule : best
  })
  return {
    decision: winner.decision,
    reason: winner.why ?? `命中规则 ${describeRule(winner)}`,
    rule: winner,
  }
}

export function describeRule(rule: Rule): string {
  const parts = [rule.tool ?? '*']
  if (rule.path) parts.push(`path=${rule.path}`)
  if (rule.command) parts.push(`command=${rule.command}`)
  return `${parts.join(' ')} → ${rule.decision}`
}
