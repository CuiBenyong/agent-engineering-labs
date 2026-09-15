/**
 * 工具注册表与统一的执行入口。来自 D1，本天从「一个 Map」扩成「循环唯一的工具出口」。
 *
 * 循环不认识任何具体工具，只认识这里的两个方法：list() 给模型看，execute() 跑一次。
 * 所有「工具会出错」的情况都在 execute 里被翻译成 ToolResult，一条也不许抛出去：
 *   - 工具名不存在（模型编了一个工具）
 *   - 参数不是合法 JSON（分片拼接的必然结果，D6 会展开）
 *   - 缺必填参数、参数类型不对
 *   - 工具自己抛异常
 * 理由只有一条：这些错误模型自己能改，抛给用户他也无从下手。
 */
import type { ToolCall, ToolContext, ToolDef, ToolResult } from './types.js'
import { truncateResult } from './truncate.js'

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>()

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重名：${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  list(): ToolDef[] {
    return [...this.tools.values()]
  }

  get size(): number {
    return this.tools.size
  }

  /** 跑一次工具调用。永远返回 ToolResult，永远不抛异常 */
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name)
    if (!tool) {
      const known = this.list()
        .map((t) => t.name)
        .join('、')
      return { ok: false, content: `没有名为 ${call.name} 的工具。可用的工具是：${known}` }
    }

    // TODO(2)：参数解析失败是常态（分片拼接、模型手滑都会导致它），
    // 要把它翻译成一条 ok 为 false 的结果回灌给模型，而不是让异常抛出去。
    // 要点：
    //   - 空字符串是合法的「无参数」，当成空对象
    //   - 回灌的文本里带上原文的前 200 字符，模型才知道自己写坏在哪
    // 提示：下面这行没有任何保护，INJECT=bad_args 时整个 REPL 会带着堆栈退出——
    // 自检第 7 项起的子进程就是在验这件事。
    const args: unknown = call.args.trim() === '' ? {} : JSON.parse(call.args)

    const missing = checkRequired(tool, args)
    if (missing.length > 0) {
      return { ok: false, content: `调用 ${tool.name} 缺少必填参数：${missing.join('、')}` }
    }

    try {
      const result = await tool.run(args, ctx)
      // 截断放在这里而不是每个工具里：工具作者只管把内容做对，预算由一处统一管
      return truncateResult(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: `${tool.name} 执行失败：${message}` }
    }
  }
}

/**
 * 只校验 required 与顶层类型。手写而不是引 schema 库，理由是：
 * 模型犯的错百分之九十是「少了一个必填参数」或「把数字写成字符串」，
 * 剩下那些复杂 schema 的边界情况，交给工具自己在 run 里判断更清楚。
 */
function checkRequired(tool: ToolDef, args: unknown): string[] {
  const required = tool.parameters.required
  if (!Array.isArray(required)) return []
  if (typeof args !== 'object' || args === null) return required.map(String)
  const bag = args as Record<string, unknown>
  return required.map(String).filter((key) => bag[key] === undefined || bag[key] === null)
}
