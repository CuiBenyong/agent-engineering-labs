/**
 * MCP 客户端：把「一条请求」变成「一个 Promise」。本天新增。
 *
 * 这个文件里没有一行关心传输是 stdio 还是 HTTP——它只做四件事：
 *   1. 发号：每条请求一个自增 id
 *   2. 配对：收到带 id 的消息就找回在等的那个 Promise；**没有 id 的是通知，不是响应**
 *   3. 超时：每条请求都有上限。**不设超时一定是错的**——stdio 上服务端不回你就永远不回，
 *      那个 await 会一直挂着，整个 Agent 就停在那儿
 *   4. 收摊：传输死掉时把所有在等的请求一次性失败掉，不让它们各等各的超时
 *
 * 两类错误在这里就分开，后面一路不再混：
 *   **协议错误**（响应里带 error）→ reject 成 McpError。工具不存在、版本不支持、
 *   头体不一致都属于这一类，模型改不了，它是我们的 bug 或者配置问题。
 *   **工具执行错误**（响应成功、result.isError 为真）→ 正常 resolve。
 *   它是给模型看的，要原样回灌让它换个参数再试。
 *   把后者也抛成异常是最常见的一个写法错误：模型从此等不到「日期格式不对」这句话，
 *   一次本来能自愈的调用就变成了一次失败。
 */
import type { JsonRpcMessage, JsonValue, McpToolDef, ToolCallResult } from './protocol.js'
import { McpError, withMeta } from './protocol.js'
import type { Transport } from './transport.js'

interface Pending {
  resolve: (value: Record<string, JsonValue>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export const DEFAULT_TIMEOUT_MS = 5000
/** 翻页的硬上限：服务端要是一直给 nextCursor，客户端不能跟着翻到天荒地老 */
const MAX_PAGES = 50

export class McpClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private dead: Error | null = null
  /** 收到的通知条数。进度通知就是从这儿计数的，自检拿它证明 SSE 那一支真的走通了 */
  notifications = 0

  constructor(
    readonly transport: Transport,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    transport.onMessage((message) => this.onMessage(message))
    transport.onFatal((error) => this.failAll(error))
  }

  async start(): Promise<void> {
    await this.transport.start()
  }

  private onMessage(message: JsonRpcMessage): void {
    // 没有 id 的是通知（notifications/progress、notifications/message…）。
    // 本课的客户端不消费它们，但要数一下——完全不理会通知的客户端，
    // 在调试 SSE 那一支时会误判成「服务端什么都没发」
    if (typeof message.id !== 'number') {
      if (message.method) this.notifications += 1
      return
    }
    const waiter = this.pending.get(message.id)
    // 找不到等待者说明这条响应迟到了（早就超时了）。丢掉，但绝不要报错：
    // 迟到的响应是正常现象，不是故障
    if (!waiter) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) {
      waiter.reject(new McpError(message.error.message ?? '未知协议错误', message.error.code))
      return
    }
    waiter.resolve(message.result ?? {})
  }

  private failAll(error: Error): void {
    this.dead = error
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  request(
    method: string,
    params: Record<string, JsonValue> = {}
  ): Promise<Record<string, JsonValue>> {
    if (this.dead) return Promise.reject(this.dead)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(`${method} 超时（${this.timeoutMs}ms）`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      // send 只管把字节送出去；它自己失败（连不上、管道已关）也要把这条请求失败掉，
      // 否则又是一次白等满超时
      this.transport.send({ jsonrpc: '2.0', id, method, params: withMeta(params) }).catch((e) => {
        const waiter = this.pending.get(id)
        if (!waiter) return
        this.pending.delete(id)
        clearTimeout(waiter.timer)
        waiter.reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
  }

  /**
   * 把工具全要过来。**tools/list 是分页的**，判据只有一条：**nextCursor 缺失才是结束**。
   *
   * 不要用「这一页比上一页少」去猜——规范没保证服务端把每页填满；更不要去解析游标，
   * 它对客户端是不透明的，原样带回去就行。这条写错的表现特别隐蔽：本机那个 server
   * 一页发得完，测起来全对；用户装的那个分了十页，于是他只看到前两个工具，
   * 而没有任何东西报错。
   */
  async listTools(): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor })
      tools.push(...((result.tools as unknown as McpToolDef[]) ?? []))
      if (typeof result.nextCursor !== 'string') break
      cursor = result.nextCursor
    }
    return tools
  }

  /** 调一次工具。注意 name 必须是**服务端上的原名**，不是加了命名空间的那个 */
  async callTool(name: string, args: Record<string, JsonValue>): Promise<ToolCallResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    return result as unknown as ToolCallResult
  }

  async close(): Promise<void> {
    this.failAll(new McpError('客户端已关闭'))
    await this.transport.close()
  }
}
