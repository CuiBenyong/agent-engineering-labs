/**
 * REPL 的输入与提问：行队列、取消按键判定、三种审批提示的措辞与解析。
 * **本天从 repl.ts 纯搬运过来，一个字符都没改。**
 *
 * 搬的理由只有一条，和前面几天一样：D17 的 repl.ts 已经贴着本课单文件上限 350 行，
 * 而今天还要往里接后台任务的启停与通知队列。**文件到了上限就拆，是这门课的纪律之一。**
 *
 * 拆的界线选在这里：留在 repl.ts 里的是**控制流**（启动、主循环、收摊），
 * 搬过来的是**输入处理**（一行字进来之后怎么排队、怎么解释）。
 * 这两样本来就是两件事，只是以前挤在一个文件里。
 */
import type { ApprovalRequest, ApprovalAnswer, Scope } from './kernel/approval.js'
import { reviewPlanCall, SUBMIT_PLAN } from './plan/submit.js'

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
 *
 * 本天多了一条 submit_plan 的分支。为什么不给它另做一套「计划审批」的链路：
 * 计划审批和工具审批问的是同一个问题——「这件事我能不能做」。不同的只是
 * **摆给用户看的内容**，而那是渲染层的职责。所以这里只多了一次特判，
 * 循环、协议、门一个字都没动。
 *
 * 计划审批只给 y / n 两个选项：a 与 w 的含义是「以后同样的操作都别问了」，
 * 而「以后所有计划都自动批准」正好把计划模式的意义抹掉。
 */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  if (request.call.name === SUBMIT_PLAN) {
    const review = reviewPlanCall(request.call)
    return [...review.lines, '批准这份计划吗？y 批准并开始执行 / n 不批（说说哪里要改）'].join('\n')
  }
  const target = request.subject.path ?? request.subject.command ?? ''
  return [
    `需要确认：${request.tool.name} ${target}`,
    `原因：${request.verdict.reason}`,
    '允许吗？y 这次可以 / a 本会话都可以 / w 写进配置 / n 不行 ',
  ].join('\n')
}

/**
 * 计划审批的回答。它和工具审批分开解析，因为**预检在这里**：
 * 一份格式不合格的计划连问都不该问出去，直接当「拒绝」把问题清单回灌给模型。
 */
export function planApprovalAnswer(request: ApprovalRequest, line: string | null): ApprovalAnswer {
  const review = reviewPlanCall(request.call)
  if (!review.plan) {
    return { approved: false, scope: 'once', note: `这份计划不合格：${review.problems.join('；')}` }
  }
  const answer = (line ?? '').trim().toLowerCase()
  if (answer === 'y') return { approved: true, scope: 'once' }
  return {
    approved: false,
    scope: 'once',
    note: answer && answer !== 'n' ? `用户没有批准，他说：${line?.trim()}` : '用户没有批准这份计划',
  }
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
