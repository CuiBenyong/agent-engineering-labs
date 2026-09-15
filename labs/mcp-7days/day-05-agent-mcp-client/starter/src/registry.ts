// 聚合层：把多个 MCP 服务端的工具合成一张给模型的工具表，并且保证
// 「一个服务端出问题不影响另一个」。客户端的价值几乎全在这一层。
import { createHash } from 'node:crypto'
import { StdioClient } from './stdio-client.js'
import type { JsonValue, McpToolDef, ToolCallResult } from './protocol.js'

export interface ServerSpec {
  /** 本地别名，由我们（客户端配置）说了算，不是服务端的 serverInfo.name。 */
  alias: string
  command: string
  args: string[]
  env?: Record<string, string>
  timeoutMs?: number
}

/** 模型 API 那一侧的工具参数形状。字段名和 MCP 不一样，这是必须手动翻译的原因。 */
export interface ModelTool {
  name: string
  description: string
  input_schema: Record<string, JsonValue>
}

interface Entry {
  modelName: string
  alias: string
  /** 服务端上的原名。调用时必须用它，不能把带前缀的名字发回服务端。 */
  toolName: string
  def: McpToolDef
}

/** 取各家模型 API 里最严的那条：名字最长 64 个字符，只能是字母数字下划线连字符。 */
const MAX_MODEL_TOOL_NAME = 64
const NAME_OK = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 拼出给模型看的工具名。前缀加在客户端这一层，别名由本地配置给。
 * 超长就截断再缀 6 位哈希：截断本身会制造新的重名，哈希是用来把它补回来的。
 */
export function modelToolName(alias: string, toolName: string): string {
  // 练习 3：现在直接把服务端上的原名交给模型，两个服务端各有一个 search 就撞了，
  // 后来的那个会被 refresh 当成重名丢掉——模型再也看不到工单里的搜索。
  // 要求：
  //   1. 用本地别名做前缀（本课约定 mcp__别名__工具名），别用服务端自报的 serverInfo.name，
  //      规范明说它不保证唯一，不能拿来消歧；
  //   2. 把不合法字符换成下划线，结果必须满足 NAME_OK；
  //   3. 超过 MAX_MODEL_TOOL_NAME 就截断，并缀上 6 位哈希——
  //      截断自己会制造新的重名，哈希是用来把唯一性补回来的。
  // createHash 已经 import 好了。
  return toolName
}

export function isValidModelToolName(name: string): boolean {
  return NAME_OK.test(name)
}

export class ToolRegistry {
  private readonly clients: StdioClient[] = []
  private readonly entries = new Map<string, Entry>()
  /** 掉线的服务端：别名到原因。留着它，才能在提示词里跟模型说清楚少了什么。 */
  readonly down = new Map<string, string>()

  connect(specs: ServerSpec[]): void {
    const seen = new Set<string>()
    for (const spec of specs) {
      // 别名撞了就是配置错误，必须在启动时炸，而不是等模型调错工具。
      if (seen.has(spec.alias)) throw new Error(`重复的服务端别名：${spec.alias}`)
      seen.add(spec.alias)
      const client = new StdioClient(spec)
      client.start()
      this.clients.push(client)
    }
  }

  /** tools/list 是分页的。只取第一页，就等于悄悄把后面的工具全弄丢了。 */
  private async listAllTools(client: StdioClient): Promise<McpToolDef[]> {
    // 练习 2：这里只取了第一页。notes 服务端每页只回 2 个工具，
    // 所以现在你会永远看不见它的第三个工具。
    // 把它改成循环：带上上一页返回的 cursor 再要一次，直到 nextCursor 不再出现。
    // 判据只有一条：nextCursor 缺失才是结束——返回空数组不是结束，
    // 页大小由服务端说了算，也不要拿页大小去猜还有没有下一页。
    // 顺手加一个页数上限，别让一个坏掉的服务端把你转到天荒地老。
    const result = await client.request('tools/list', {})
    return (result.tools ?? []) as unknown as McpToolDef[]
  }

  /**
   * 逐个服务端拉工具。每个服务端各自 try/catch：一个挂了记进 down，
   * 其余照常可用。整轮对话不能被一个超时的服务端拖死。
   */
  async refresh(): Promise<void> {
    this.entries.clear()
    this.down.clear()
    for (const client of this.clients) {
      // 练习 4：这里没有任何隔离。一个服务端超时或者进程没起来，
      // 这个 await 就会把异常一路抛到调用方，另一个健康服务端的工具也跟着没了。
      // 要求：把单个服务端的发现与列举包进 try/catch，失败时
      //   1. 把原因记进 this.down（别只记一个 false，事后要能说清少了什么）；
      //   2. 继续处理下一个服务端，整轮对话不能因此失败。
      await client.request('server/discover')
      const tools = await this.listAllTools(client)
      for (const def of tools) {
        const modelName = modelToolName(client.alias, def.name)
        if (this.entries.has(modelName)) {
          // 加过前缀还撞名，只可能是截断造成的。跳过并留痕，别悄悄覆盖。
          console.error(`   [聚合] 丢弃重名工具 ${modelName}（${client.alias} 的 ${def.name}）`)
          continue
        }
        this.entries.set(modelName, { modelName, alias: client.alias, toolName: def.name, def })
      }
    }
  }

  /** 翻译成模型 API 的工具参数。丢掉的东西比看上去多，注释里逐条说了。 */
  modelTools(): ModelTool[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.modelName,
      // 描述是模型选工具的唯一依据。title 是给人看的，不能拿它替代 description；
      // 两个 search 撞名时，把来源写进描述比只靠名字前缀更容易被模型选对。
      description: `[来自 ${entry.alias}] ${entry.def.description ?? entry.def.title ?? entry.def.name}`,
      // 注解（readOnlyHint / destructiveHint）在模型 API 那边没有对应字段，
      // 翻译时必然丢失，所以确认与拦截只能由客户端自己按注解做，别指望模型。
      input_schema: entry.def.inputSchema,
    }))
  }

  lookup(modelName: string): Entry | undefined {
    // 反查只走这张表。绝不能靠切字符串把名字拆回别名与工具原名：
    // 工具原名里本来就可能有下划线，截断过的名字更是拆不回来。
    return this.entries.get(modelName)
  }

  /**
   * 调用一个工具。这个方法不抛异常：任何失败都翻译成 isError 的工具结果，
   * 让模型看见、有机会自己改；抛出去只会让整轮对话崩掉。
   */
  async call(modelName: string, args: Record<string, JsonValue>): Promise<ToolCallResult> {
    const entry = this.lookup(modelName)
    if (!entry) {
      const known = [...this.entries.keys()].join('、')
      return {
        isError: true,
        content: [{ type: 'text', text: `没有名为 ${modelName} 的工具。可用工具：${known}` }],
      }
    }
    const client = this.clients.find((c) => c.alias === entry.alias)
    if (!client || this.down.has(entry.alias)) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `服务端 ${entry.alias} 当前不可用，请改用其它工具或直接回答。` },
        ],
      }
    }
    try {
      const result = await client.request('tools/call', { name: entry.toolName, arguments: args })
      return result as unknown as ToolCallResult
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        isError: true,
        content: [{ type: 'text', text: `调用 ${modelName} 失败：${message}` }],
      }
    }
  }

  toolNames(): string[] {
    return [...this.entries.keys()]
  }

  closeAll(): void {
    for (const client of this.clients) client.close()
  }
}
