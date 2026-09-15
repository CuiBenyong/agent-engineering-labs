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
  return {
    type: 'function',
    function: {
      name: tool.name,
      // 描述会原样进模型的上下文，缺了它模型就只能靠工具名猜用途（D5 的口径）
      description: tool.description ?? '',
      parameters: {
        type: 'object',
        properties: tool.inputSchema.properties ?? {},
        required: tool.inputSchema.required ?? [],
      },
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
  const reasons: string[] = []
  if (s.hostCount > 1) reasons.push(`要被 ${s.hostCount} 个宿主复用，接一次就够了`)
  if (s.ownedByOthers) reasons.push('由另一个团队或第三方维护，进程边界就是责任边界')
  if (s.hotSwappable) reasons.push('要求不改宿主代码就能增删能力，配置里加一行即可')
  if (reasons.length > 0) return { use: true, reasons }
  return {
    use: false,
    reasons: ['三条判据一条都没命中：多一个进程、多一次握手、多一层排障，直接写 function calling'],
  }
}
