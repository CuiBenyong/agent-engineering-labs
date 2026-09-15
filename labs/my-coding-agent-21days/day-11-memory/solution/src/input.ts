/**
 * 终端输入的三件小事：行队列、取消按键的判定、审批提问的排版与解析。
 * 来自 D10，本天改了一处：**审批提示在没有 path / command 时退回显示参数摘要。**
 *
 * 起因是今天新增的 remember 工具既不动路径也不跑命令，于是审批提示只剩一句
 * 「需要确认：remember」——用户根本不知道要记的是什么，只能一路按 y。
 * 审批提示的唯一职责是**说清将要发生什么**，说不清的门就是个摆设（第十天那句
 * 「门的价值取决于它多久响一次」的另一半：还取决于它响的时候说了什么）。
 *
 * 原 D10 说明：
 * 为什么从 repl.ts 搬出来：那个文件在 D9 之后已经贴到 350 行（本课的单文件上限），
 * 而这三件事和「输入循环」本来就是两层——**它们是纯函数与一个小数据结构，
 * 可以被自检直接断言；输入循环是控制流，只能靠管道跑**。
 * 文件到了上限就拆，是这门课的纪律之一：D6 把命令表拆到 commands.ts 用的是同一条理由。
 */
import type { ApprovalRequest, ApprovalAnswer, Scope } from './kernel/approval.js'

/**
 * 行队列：readline 的 line 事件进来，谁在等谁取走。
 * 主循环与审批提示共用它，所以同一行永远只被一个消费者拿到。
 */
export class LineQueue {
  private readonly lines: string[] = []
  private readonly waiters: Array<(line: string | null) => void> = []
  private closed = false

  push(line: string): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(line)
    else this.lines.push(line)
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0) this.waiters.shift()?.(null)
  }

  /** 取下一行；输入结束时返回 null */
  next(): Promise<string | null> {
    const buffered = this.lines.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

/** keypress 事件给的按键描述。只声明我们用到的三个字段 */
export interface KeyInfo {
  name?: string
  ctrl?: boolean
  meta?: boolean
}

/**
 * 这个按键是要取消当前这一轮吗。
 *
 * 两个键都收：Esc 是「停下这一轮」，Ctrl+C 在有任务时也是停这一轮、没任务时才退出程序。
 * 单独抽成函数是为了能被自检直接断言——按键这一环在管道里跑不到，
 * 但「哪些键算取消」这条判断可以验。
 */
export function isCancelKey(key: KeyInfo | undefined): boolean {
  if (!key) return false
  if (key.name === 'escape' && !key.meta) return true
  return key.name === 'c' && Boolean(key.ctrl)
}

/**
 * 终端里的审批提示。四个选项对应三种记忆范围：
 *   y 这次可以（本轮）｜ a 以后都可以（本会话）｜ w 写进配置（持久）｜ n 不行
 */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  const target = request.subject.path ?? request.subject.command ?? previewArgs(request.call.args)
  return [
    `需要确认：${request.tool.name} ${target}`,
    `原因：${request.verdict.reason}`,
    '允许吗？y 这次可以 / a 本会话都可以 / w 写进配置 / n 不行 ',
  ].join('\n')
}

/**
 * 没有 path 也没有 command 的工具，拿它参数里第一个字符串字段当摘要。
 * 解析不出来就退回参数原文的头一截——**宁可难看，也不能什么都不说。**
 */
function previewArgs(args: string): string {
  try {
    const parsed = JSON.parse(args || '{}') as Record<string, unknown>
    const first = Object.values(parsed).find((value) => typeof value === 'string')
    if (typeof first === 'string') return first.length > 60 ? `${first.slice(0, 60)}…` : first
  } catch {
    // 落到下面那行
  }
  return args.slice(0, 60)
}

/** 把一行回答解析成审批结果。看不懂的回答按拒绝处理，不按同意 */
export function parseApprovalAnswer(line: string | null): ApprovalAnswer {
  const answer = (line ?? '').trim().toLowerCase()
  const scopes: Record<string, Scope> = { y: 'once', a: 'session', w: 'config' }
  const scope = scopes[answer]
  if (scope) return { approved: true, scope }
  return {
    approved: false,
    scope: 'once',
    note:
      answer === 'n' || answer === ''
        ? '用户拒绝了这次操作'
        : `用户的回答是「${answer}」，按拒绝处理`,
  }
}
