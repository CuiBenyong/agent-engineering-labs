// 桥接层：MCP 的 tool 描述 ←→ function calling 的 JSON Schema。
// 这个文件是全天的立论点所在——MCP 不是 function calling 的替代品，
// 而是它的上游：MCP server 列出来的每个 tool，最后都要被翻译成这里的 FunctionTool 发给模型。

/** MCP `tools/list` 返回的单个工具描述里，我们真正用得上的那几个字段。 */
export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] }
}

/** 发给模型的形状：OpenAI 兼容接口的 tools 数组元素，各家大同小异。 */
export interface FunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: { type: 'object'; properties: Record<string, object>; required: string[] }
  }
}

/**
 * 三行代码的映射，却是整条链路上最关键的一步：
 * MCP 的 inputSchema 本身就是 JSON Schema，所以「翻译」其实是原样搬运。
 * 正因为便宜，才没有理由把 MCP 讲成 function calling 的替代品——它们是上下游。
 */
export function toFunctionTool(tool: McpToolDescriptor): FunctionTool {
  // 练习 2：把 MCP 的 inputSchema 搬进 function calling 的 parameters。
  // 三处要搬：properties、required，以及别忘了 description——它会原样进模型的上下文，
  // 缺了它模型只能靠工具名猜用途（D5 的口径）。
  // 提示：inputSchema 本身就是 JSON Schema，这一步是原样搬运，不是格式转换。
  //       现在这个空壳能跑，但模型会看到一个「不接受任何参数」的工具，
  //       于是它交上来一个空对象，被 server 的参数校验挡回来——这就是你要看到的现象。
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: '',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }
}

/** MCP 的工具结果是一个块数组（可能含图片、资源引用），回给模型之前要压成文本。 */
export interface ToolOutcome {
  ok: boolean
  text: string
}

export function flattenToolResult(result: unknown): ToolOutcome {
  const shape = (result ?? {}) as { content?: unknown; isError?: unknown }
  const blocks = Array.isArray(shape.content) ? shape.content : []
  const text = blocks
    .map((block) => {
      if (typeof block === 'object' && block !== null && 'type' in block) {
        const typed = block as { type: string; text?: string }
        if (typed.type === 'text') return typed.text ?? ''
        return `[${typed.type} 块，本实验不渲染]`
      }
      return ''
    })
    .filter((s) => s.length > 0)
    .join('\n')
  // isError 是 MCP 的协议字段，不是异常：工具业务上失败了，但这次 RPC 是成功的。
  // 所以它要按 D5 的错误回传口径原样交给模型，让模型自己改参数重试。
  return { ok: shape.isError !== true, text }
}

/** 选型判据的输入：一次「要不要把这个能力做成 MCP server」的决策现场。 */
export interface CapabilityScenario {
  name: string
  /** 这个能力要被几个宿主用（自己的 Agent、IDE、别人的客户端……） */
  hostCount: number
  /** 维护方是不是另一个团队或第三方 */
  ownedByOthers: boolean
  /** 是否要求不改宿主代码就能增删能力 */
  hotSwappable: boolean
}

export interface McpVerdict {
  use: boolean
  reasons: string[]
}

/**
 * 三条判据，命中任意一条才考虑 MCP，一条都不命中就直接写 function calling。
 * 默认答案是「不用」——这一点和 D15 的「要不要拆多 Agent」是同一个套路。
 */
export function shouldUseMcp(s: CapabilityScenario): McpVerdict {
  // 练习 5：把三条判据写出来——多宿主复用 / 别人维护 / 不改代码增删能力，
  // 命中任意一条才返回 use: true，一条都不命中要明确返回 false 并说清代价。
  // 提示：默认答案是「不上」，这和 D15「要不要拆多 Agent」是同一个套路。
  //       下面这个恒真的实现，正是正文里点名批判的「什么能力都先包成 MCP server」。
  void s
  return { use: true, reasons: ['先包成 MCP server 再说'] }
}
