/**
 * Streamable HTTP 传输。本天新增。
 *
 * 与 stdio 最大的不同是**一次请求的响应有两种形状**，而且由服务端临时决定：
 *
 *   application/json    一个响应体就是一条完整的 JSON-RPC 响应，收完就结束
 *   text/event-stream   一条 SSE 流：中间可以夹若干条通知（进度、日志），
 *                       最后一条才是带 id 的响应。**流结束 ≠ 请求成功**
 *
 * 所以这一层必须**两种都能收**，而且不能假设「响应就是最后一条消息」——
 * 判据只有一个：**带 id 且 id 对得上的那条才是响应**，其余一律是通知。
 * 上一版协议里那条单独的 GET 长连接在 2026-07-28 被删掉了，服务端主动推的东西
 * 只能搭在某一次请求的响应流上，这条规则因此是硬性的。
 *
 * 三条同样被删掉的东西，写客户端时要特别注意别照老教程写：
 *   - Mcp-Session-Id 会话头（服务端不铸也不回显，我们也不发）
 *   - HTTP DELETE 终止会话
 *   - Last-Event-ID 断流续传。**流断了就是这次请求丢了，必须换一个新 id 重发**
 */
import type { JsonRpcMessage } from './protocol.js'
import { PROTOCOL_VERSION } from './protocol.js'
import { LineFramer, parseMessage, type Transport } from './transport.js'

/** 带 name / uri 参数的三个方法要额外镜像一个 Mcp-Name 头 */
const NAMED_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get'])

/**
 * HTTP 头的值只允许可见 ASCII，而工具名可以是中文。规范给了一个哨兵格式：
 * 把 UTF-8 字节 Base64 之后包起来。服务端必须先解码再比对，否则一个完全正常的
 * 请求会被它自己的校验判成「头体不一致」。
 */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export interface HttpOptions {
  url: string
  headers?: Record<string, string>
  log?: (line: string) => void
}

export class HttpTransport implements Transport {
  readonly kind = 'http'
  readonly label: string
  private onMessageHandler: (message: JsonRpcMessage) => void = () => {}
  private onFatalHandler: (error: Error) => void = () => {}
  private closed = false

  constructor(private readonly options: HttpOptions) {
    this.label = `http ${options.url}`
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.onMessageHandler = handler
  }

  onFatal(handler: (error: Error) => void): void {
    this.onFatalHandler = handler
  }

  start(): Promise<void> {
    // 无状态协议在这里的红利：**没有要建立的连接。** 没有握手、没有会话，
    // 所以也没有「连上了但还没握手完」这种中间态要处理
    return Promise.resolve()
  }

  async send(payload: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('传输已关闭')
    const params = payload.params ?? {}
    const named = payload.method && NAMED_METHODS.has(payload.method)
    const target = named ? (params.name ?? params.uri) : undefined

    const response = await fetch(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 两种都接受：服务端按这次调用的性质自己挑一种回
        accept: 'application/json, text/event-stream',
        // 下面三个头是这一版新增的必填项：把请求体里的关键字段镜像到头上，
        // 让网关、限流器、探针不必解析请求体就能路由。**镜像错了是漏洞不是笔误**：
        // 服务端必须校验头体一致，不一致回 400 加 -32020
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(payload.method ? { 'mcp-method': encodeHeaderValue(payload.method) } : {}),
        ...(typeof target === 'string' ? { 'mcp-name': encodeHeaderValue(target) } : {}),
        ...this.options.headers,
      },
      body: JSON.stringify(payload),
    })

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      await this.readEventStream(response, payload.id ?? null)
      return
    }

    // 非 2xx 也可能带一个合法的 JSON-RPC 错误体（-32020 头体不一致、-32022 版本不支持
    // 都是 400）。所以先当消息解析，解析不出来才退化成一条自造的错误
    const text = await response.text()
    const message = parseMessage(text)
    if (message) {
      this.onMessageHandler(message)
      return
    }
    this.onMessageHandler({
      jsonrpc: '2.0',
      id: payload.id ?? null,
      error: { code: response.status, message: `HTTP ${response.status}：${text.slice(0, 200)}` },
    })
  }

  /**
   * 读一条 SSE 流。只认 data: 开头的行，冒号开头的是注释（服务端拿它保活），必须忽略。
   *
   * 流在中途断掉时要主动报错：**流结束不等于请求成功**。少了下面那个 answered 判断，
   * 一条半路断掉的流会让调用方一直等到超时，而真正的原因（连接断了）就再也看不见了。
   */
  private async readEventStream(response: Response, id: number | string | null): Promise<void> {
    const body = response.body
    if (!body) throw new Error('服务端说是事件流，却没有响应体')
    const decoder = new TextDecoder()
    const framer = new LineFramer()
    let answered = false

    // TODO(3)：把流里的每一条消息都交上去，并用 id 判断哪一条才是这次请求的响应。
    // 下面这版假设「最后一条就是响应」，于是中间那些通知全被吞掉，
    // 而服务端在结果后面多发一条日志通知时，这个客户端就会拿错东西。
    const lines: string[] = []
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      lines.push(...framer.push(decoder.decode(chunk, { stream: true })))
    }
    lines.push(...framer.flush())
    const last = lines.filter((line) => line.startsWith('data:')).at(-1)
    const message = last ? parseMessage(last.slice('data:'.length).trim()) : null
    if (message) {
      answered = true
      this.onMessageHandler(message)
    }

    if (!answered) {
      this.onMessageHandler({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: '事件流结束了，但没有收到这条请求的响应（流被中断）' },
      })
    }
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}
