/**
 * 聚合层：把若干个 MCP server 的工具合成一批本地 ToolDef。本天新增。
 *
 * 客户端的价值几乎全在这一层，它管三件事——命名、信任、失败。
 *
 * **命名。** 规范只保证工具名在**单个 server 内**唯一，所以两个 server 各有一个
 * search 是必然事件不是意外。前缀必须来自**我们自己的配置别名**，不能用服务端自报的
 * 名字（它同样不保证跨 server 唯一）。别名撞了就是配置错误，必须在启动时炸。
 *
 * **信任。** 远端工具是别人的代码跑在别人的进程里。本课的口径写死一条：
 * **远端工具一律 readOnly 为 false**，于是它们全部落进第五天那道审批门的 ask 分支。
 * 服务端在 annotations 里声明的 readOnlyHint **不作数**——那是被调用方给自己发的
 * 通行证。规范本身也要求客户端把工具注解当成不可信输入。
 *
 * **失败。** 一个 server 挂掉，最坏的后果应该是**少几个工具**，不是这一轮对话失败。
 * 所以发现阶段逐个 try/catch 并把原因记进掉线表，调用阶段一律不抛。
 */
import { createHash } from 'node:crypto'
import type { ToolContext, ToolDef, ToolResult } from '../kernel/types.js'
import type { JsonValue, McpToolDef } from './protocol.js'
import { isInputRequired, resultText } from './protocol.js'
import { McpClient } from './client.js'
import { StdioTransport } from './stdio.js'
import { HttpTransport } from './http.js'

export type ServerSpec =
  | { alias: string; kind: 'stdio'; command: string; args: string[]; timeoutMs?: number }
  | { alias: string; kind: 'http'; url: string; timeoutMs?: number }

/** 取各家模型 API 里最严的那条：最长 64 个字符，只能是字母数字下划线连字符 */
const MAX_TOOL_NAME = 64

/**
 * 拼一个带命名空间的本地工具名。超长就截断再缀 6 位哈希——
 * **截断本身会制造新的重名，哈希是用来把唯一性补回来的。**
 */
export function namespacedName(alias: string, toolName: string): string {
  const raw = `mcp__${alias}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_')
  if (raw.length <= MAX_TOOL_NAME) return raw
  const digest = createHash('sha1').update(`${alias}::${toolName}`).digest('hex').slice(0, 6)
  return `${raw.slice(0, MAX_TOOL_NAME - 7)}_${digest}`
}

export interface Entry {
  localName: string
  alias: string
  /** server 上的原名。调用时必须用它 */
  toolName: string
  def: McpToolDef
}

export interface MountOptions {
  log?: (line: string) => void
}

export class McpMount {
  private readonly clients = new Map<string, McpClient>()
  private readonly entries = new Map<string, Entry>()
  /** 掉线的 server：别名到原因。留着原因，才能回答「少了什么、为什么少」 */
  readonly down = new Map<string, string>()

  constructor(private readonly options: MountOptions = {}) {}

  /**
   * 逐个连接、逐个发现。**每个 server 单独 try/catch**：一个连不上不影响其它的。
   * 返回这次一共挂上了多少个工具，用于在终端上报一句账。
   */
  async connect(specs: ServerSpec[]): Promise<number> {
    const seen = new Set<string>()
    for (const spec of specs) {
      if (seen.has(spec.alias)) throw new Error(`重复的 server 别名：${spec.alias}`)
      seen.add(spec.alias)
      try {
        const client = new McpClient(this.transportFor(spec), spec.timeoutMs)
        await client.start()
        const tools = await client.listTools()
        this.clients.set(spec.alias, client)
        for (const def of tools) this.add(spec.alias, def)
        this.options.log?.(`[mcp] ${spec.alias}（${spec.kind}）挂上 ${tools.length} 个工具`)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.down.set(spec.alias, reason)
        this.options.log?.(`[mcp] ⚠ ${spec.alias} 连不上：${reason}（其它 server 照常可用）`)
      }
    }
    return this.entries.size
  }

  private transportFor(spec: ServerSpec): StdioTransport | HttpTransport {
    const log = this.options.log
    if (spec.kind === 'stdio') {
      return new StdioTransport({
        command: spec.command,
        args: spec.args,
        ...(log ? { log } : {}),
      })
    }
    return new HttpTransport({ url: spec.url, ...(log ? { log } : {}) })
  }

  private add(alias: string, def: McpToolDef): void {
    const localName = namespacedName(alias, def.name)
    if (this.entries.has(localName)) {
      // 同一个别名下重名，说明是 server 自己发重了。跳过而不是覆盖：覆盖会让
      // 「调到哪一个」取决于翻页顺序，而那是最难查的一类不确定
      this.options.log?.(`[mcp] ⚠ ${localName} 重名，已跳过后来的那个`)
      return
    }
    this.entries.set(localName, { localName, alias, toolName: def.name, def })
  }

  /**
   * 反查只走这张表。**绝不能靠切字符串把名字拆回别名与原名**——原名里本来就允许有
   * 下划线（read_note、close_ticket），被截断过的更是拆不回来。
   */
  entryOf(localName: string): Entry | undefined {
    return this.entries.get(localName)
  }

  list(): Entry[] {
    return [...this.entries.values()]
  }

  /**
   * 把远端工具翻译成本地 ToolDef。**翻译是有损的**，损在哪要心里有数：
   * annotations 与 outputSchema 都不往下传——前者不可信（见文件头），
   * 后者本课的循环用不上，留着只会多占 token。title 也不传，它是给界面看的。
   */
  toolDefs(): ToolDef[] {
    return this.list().map((entry) => ({
      name: entry.localName,
      // 来源写进描述里：名字前缀是给程序看的，**描述才是模型选工具的唯一依据**
      description: `[来自 MCP server ${entry.alias}] ${entry.def.description ?? entry.def.name}`,
      parameters: entry.def.inputSchema,
      // TODO(4)：远端工具该不该采信服务端自己声明的 readOnlyHint？
      // 想清楚这条声明是谁写的、它决定了什么，再决定这里填什么
      readOnly: entry.def.annotations?.readOnlyHint === true,
      run: (args: unknown, _ctx: ToolContext) => this.call(entry.localName, args),
    }))
  }

  /**
   * 调一次远端工具。**这个方法永远不抛**：所有失败都翻译成 ok 为 false 的结果，
   * 模型看得见才有机会改口。结果的截断不在这里做——它由注册表统一走 D3 那条路，
   * 远端工具因此和本地工具用的是同一份预算。
   */
  async call(localName: string, args: unknown): Promise<ToolResult> {
    const entry = this.entries.get(localName)
    if (!entry) return { ok: false, content: `没有名为 ${localName} 的工具` }
    const client = this.clients.get(entry.alias)
    if (!client) {
      const why = this.down.get(entry.alias) ?? '未连接'
      return { ok: false, content: `MCP server ${entry.alias} 当前不可用：${why}` }
    }
    try {
      // 注意发出去的是 entry.toolName（原名）。带命名空间的名字只在模型与我们之间
      // 流通，server 根本不认识它
      const payload = (args ?? {}) as Record<string, JsonValue>
      // TODO(5)：这里发出去的名字写错了。想一想 server 认识的是哪一个名字
      const result = await client.callTool(entry.localName, payload)
      if (isInputRequired(result)) {
        return {
          ok: false,
          content:
            `${entry.alias} 的 ${entry.toolName} 要求补充输入才能继续，而 mca 还没有实现这一支。` +
            '请换一个不需要交互的做法。',
          meta: { alias: entry.alias, resultType: result.resultType },
        }
      }
      // isError 为真是**成功的响应**，它是给模型看的执行错误，原样回灌
      return {
        ok: result.isError !== true,
        content: resultText(result),
        meta: { alias: entry.alias, tool: entry.toolName },
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        content: `调用 ${localName} 失败：${reason}`,
        meta: { alias: entry.alias },
      }
    }
  }

  /**
   * 掉线的 server 要让人看得见。**静默降级比掉线更糟**：模型会表现得像那个能力
   * 从来不存在，只说「我查不到」，而不是「工单系统这会儿连不上」。
   */
  report(): string[] {
    const rows = this.list().map((e) => `  ${e.localName}  ←  ${e.alias}:${e.toolName}`)
    for (const [alias, reason] of this.down) rows.push(`  ⚠ ${alias} 掉线：${reason}`)
    return rows
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) await client.close()
    this.clients.clear()
  }
}
