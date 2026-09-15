// 一个最小的 stdio MCP 客户端：拉起子进程、按行收发 JSON-RPC、把响应配回请求。
// 三个阶段：start（拉起）→ request（发现与调用）→ close（收摊）。
import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { withMeta, type JsonValue } from './protocol.js'

export class McpError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'McpError'
    this.code = code
  }
}

interface Pending {
  resolve: (value: Record<string, JsonValue>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface StdioClientOptions {
  alias: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** 单条请求的超时。公网服务端可以放宽，但绝不能不设。 */
  timeoutMs?: number
}

export class StdioClient {
  readonly alias: string
  private readonly options: StdioClientOptions
  private child: ChildProcess | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false

  constructor(options: StdioClientOptions) {
    this.options = options
    this.alias = options.alias
  }

  start(): void {
    const child = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.options.env ?? {}) },
    })
    this.child = child

    // 服务端的日志只能走 stderr。它往 stdout 多打一个字，这里的 JSON.parse 就炸。
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) console.error(`   [${this.alias}:stderr] ${line}`)
      }
    })

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => this.onLine(line))
    }

    child.on('exit', (code) => {
      this.failAll(new McpError(`服务端 ${this.alias} 退出了（code=${code}）`))
    })
    child.on('error', (error) => {
      this.failAll(new McpError(`服务端 ${this.alias} 起不来：${error.message}`))
    })
  }

  /**
   * 收到一行就配一次对。stdio 上「一行一条消息」，所以配对只需要看 id。
   * 三件事一件都不能少：按 id 找回等待者、清掉定时器、把 error 分支也认了。
   * 漏掉 error 分支的客户端会在服务端明确报错时干等到超时——最难查的那种慢。
   */
  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: {
      id?: number
      result?: Record<string, JsonValue>
      error?: { code?: number; message?: string }
    }
    try {
      msg = JSON.parse(line)
    } catch {
      console.error(`   [${this.alias}] 收到无法解析的一行：${line.slice(0, 120)}`)
      return
    }
    if (typeof msg.id !== 'number') return // 通知没有 id，本课的客户端直接忽略
    const waiter = this.pending.get(msg.id)
    if (!waiter) return // 迟到的响应：早就超时了，丢掉
    this.pending.delete(msg.id)
    clearTimeout(waiter.timer)
    if (msg.error) {
      waiter.reject(
        new McpError(`${this.alias}: ${msg.error.message ?? '未知错误'}`, msg.error.code)
      )
      return
    }
    waiter.resolve(msg.result ?? {})
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  request(
    method: string,
    params: Record<string, JsonValue> = {},
    timeoutMs = this.options.timeoutMs ?? 3000
  ): Promise<Record<string, JsonValue>> {
    if (this.closed || !this.child?.stdin) {
      return Promise.reject(new McpError(`服务端 ${this.alias} 已关闭`))
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: withMeta(params) })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(`服务端 ${this.alias} 的 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin?.write(payload + '\n')
    })
  }

  close(): void {
    this.closed = true
    this.failAll(new McpError(`服务端 ${this.alias} 已关闭`))
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
  }
}
