/**
 * 把四类工具事件归并成一张有状态的卡片。
 *
 * 事件是分散到达的：START 给名字，ARGS 一片片给参数，END 说参数发完了，
 * RESULT 给执行结果。它们之间可能穿插别的消息，所以必须按 toolCallId 归组，
 * 不能依赖到达顺序。
 */

export type ToolCallStatus =
  /** 参数还在流式到达，parse 不出来 */
  | 'preparing'
  /** 参数收齐，工具正在执行 */
  | 'running'
  /** 等用户批准 */
  | 'awaiting-approval'
  | 'success'
  | 'error'
  /** 用户拒绝了 */
  | 'rejected'

export type ToolCall = {
  id: string
  name: string
  /** 已收到的参数片段拼接结果，可能是半截 JSON */
  rawArgs: string
  /** 拼完并成功 parse 的参数；没 parse 出来就是 null */
  args: Record<string, unknown> | null
  status: ToolCallStatus
  result: string | null
  parentMessageId?: string
}

export function createToolCall(id: string, name: string, parentMessageId?: string): ToolCall {
  return {
    id,
    name,
    rawArgs: '',
    args: null,
    status: 'preparing',
    result: null,
    parentMessageId,
  }
}

/**
 * 追加一片参数。
 *
 * 关键：**不要在这里 JSON.parse**。参数是一片片来的，
 * 中途任何时刻拿到的都可能是 `{"path":"reports/20` 这种半截字符串，
 * parse 一定抛异常。所以边收边存原文，等 END 到了再一次性 parse。
 */
export function appendArgs(call: ToolCall, delta: string): ToolCall {
  return { ...call, rawArgs: call.rawArgs + delta }
}

/**
 * 参数收齐：现在才能 parse。
 *
 * parse 仍然可能失败（模型偶尔会吐出不合法的 JSON），失败时不要崩，
 * 把状态标成 error 并把原文留着给用户看——这比一个白屏有用得多。
 */
export function finalizeArgs(call: ToolCall): ToolCall {
  try {
    const parsed: unknown = JSON.parse(call.rawArgs || '{}')
    if (!parsed || typeof parsed !== 'object') throw new Error('参数不是对象')
    return { ...call, args: parsed as Record<string, unknown>, status: 'running' }
  } catch {
    return { ...call, status: 'error', result: `参数不是合法的 JSON：${call.rawArgs}` }
  }
}

export function applyResult(call: ToolCall, content: string): ToolCall {
  // 约定：结果里带 error 字段就算失败。真实项目里这个约定由你的工具层定义。
  let failed = false
  let rejected = false
  try {
    const parsed = JSON.parse(content) as { error?: string }
    failed = typeof parsed.error === 'string'
    rejected = parsed.error === 'rejected_by_user'
  } catch {
    // 结果不是 JSON 也很正常，当成功的纯文本结果处理
  }
  return {
    ...call,
    status: rejected ? 'rejected' : failed ? 'error' : 'success',
    result: content,
  }
}

/** 供界面显示的参数摘要：参数没收齐时给一个可读的占位。 */
export function describeArgs(call: ToolCall): string {
  if (call.args) {
    const entries = Object.entries(call.args)
    if (entries.length === 0) return '无参数'
    return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('，')
  }
  if (call.status === 'preparing') {
    // 刻意不显示半截 JSON 原文：那看起来像出错了。
    // 显示「正在准备参数」加一个字符数，既诚实又不吓人。
    return `正在准备参数…（已收到 ${call.rawArgs.length} 个字符）`
  }
  return call.rawArgs || '无参数'
}

/**
 * 哪些工具需要用户确认。
 *
 * 这份清单在**前端**只是用来提前提示，真正的拦截必须在服务端——
 * 前端的判断可以被绕过（改改请求就行），把它当安全边界是个典型错误。
 * 服务端的中断才是唯一可靠的那道门。
 */
const DESTRUCTIVE_PREFIXES = ['delete_', 'remove_', 'drop_', 'send_', 'pay_', 'deploy_']

export function looksDestructive(toolName: string): boolean {
  return DESTRUCTIVE_PREFIXES.some((p) => toolName.startsWith(p))
}
