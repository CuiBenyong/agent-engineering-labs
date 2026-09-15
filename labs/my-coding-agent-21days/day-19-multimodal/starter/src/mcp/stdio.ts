/**
 * stdio 传输：把 server 当子进程拉起来，标准输入写请求、标准输出读响应。本天新增。
 *
 * 这是本地 server 的默认形态，也是最容易写错的一种，坑集中在**进程生命周期**上：
 *
 *   1. **server 的日志只能走 stderr。** 它往 stdout 多打一个换行，
 *      这里的 JSON.parse 就开始报错——而报的错长得像「协议坏了」，跟日志毫无关系。
 *   2. **子进程退出时要把所有在等的请求一次性失败掉。** 不这么做，那些 await
 *      会一直挂到超时；而 server 起不来时（命令拼错、依赖缺失）每一条请求都要等满超时，
 *      一次发现就是十几秒的干等。
 *   3. **关闭要先 end stdin 再 kill。** 直接 kill 会让 server 来不及收摊；
 *      而只 end 不 kill，赖着不退的 server 会把父进程一起挂住。
 *   4. **父进程退出不会自动带走子进程。** 本课在 close 里显式 kill，
 *      REPL 退出、自检结束都要记得调——否则跑几次之后机器上会留一串孤儿进程。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { JsonRpcMessage } from './protocol.js'
import { LineFramer, parseMessage, type Transport } from './transport.js'

export interface StdioOptions {
  command: string
  args: string[]
  env?: Record<string, string>
  /** server 往 stderr 打的日志转到哪儿。不传就丢弃 */
  log?: (line: string) => void
}

export class StdioTransport implements Transport {
  readonly kind = 'stdio'
  readonly label: string
  private child: ChildProcess | null = null
  private readonly framer = new LineFramer()
  private onMessageHandler: (message: JsonRpcMessage) => void = () => {}
  private onFatalHandler: (error: Error) => void = () => {}
  private closed = false

  constructor(private readonly options: StdioOptions) {
    this.label = `stdio ${options.command} ${options.args.join(' ')}`.trim()
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.onMessageHandler = handler
  }

  onFatal(handler: (error: Error) => void): void {
    this.onFatalHandler = handler
  }

  start(): Promise<void> {
    const child = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.options.env ?? {}) },
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.framer.push(chunk)) {
        const message = parseMessage(line)
        // 解析不了就只记一笔。一行坏报文不该杀掉整个传输——多半是 server 往 stdout
        // 打了日志，而剩下那些正常报文还得继续收
        if (message) this.onMessageHandler(message)
        else this.options.log?.(`[${this.label}] 收到无法解析的一行：${line.slice(0, 120)}`)
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) this.options.log?.(`[stderr] ${line}`)
    })

    child.on('exit', (code) => {
      if (this.closed) return
      this.onFatalHandler(new Error(`server 进程退出了（code=${code}）`))
    })
    // 命令根本起不来（拼错、不存在）走这一支，不走 exit
    child.on('error', (error) => this.onFatalHandler(new Error(`server 起不来：${error.message}`)))

    // 注意这里不等任何「就绪信号」：无状态协议没有握手，第一条真实请求就是探活。
    // 起不来的 server 会在那条请求上以 fatal 或超时暴露出来，而不是卡在 start 里
    return Promise.resolve()
  }

  send(payload: JsonRpcMessage): Promise<void> {
    if (this.closed || !this.child?.stdin) return Promise.reject(new Error('传输已关闭'))
    // 一行一条消息，所以 JSON 里绝不能有裸换行——JSON.stringify 会把它转义成 \n，
    // 这正是「按行分帧」能成立的原因
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
    return Promise.resolve()
  }
}
