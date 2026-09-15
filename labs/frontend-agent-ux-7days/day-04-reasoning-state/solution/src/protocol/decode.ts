/**
 * 【冻结文件 · D1 定稿】D2–D7 逐字复制，不要就地修改。
 * 改动后必须跑 bash scripts/check-feux-consistency.sh 复验一致性。
 *
 * 把 HTTP 响应体的字节流解成一个个 AG-UI 事件。
 *
 * 为什么不用 EventSource：它只支持 GET、不能带请求体、不能自定义请求头，
 * 而 Agent 请求要 POST 一整份对话历史并带 Authorization。三条硬伤，第一步就卡住。
 */

import type { BaseEvent } from './events'

/** 按 SSE 规范，事件之间用空行分隔。兼容 \r\n 与 \n 两种换行。 */
const EVENT_SEPARATOR = /\r?\n\r?\n/

export type DecodeOptions = {
  /** 收到无法解析成 JSON 的数据块时回调，默认在开发模式下打 console 日志 */
  onMalformed?: (raw: string, error: unknown) => void
}

/**
 * 把一条 SSE 响应解成事件的异步迭代器。
 *
 * 用法：
 *   for await (const event of decodeEventStream(res)) { ... }
 */
export async function* decodeEventStream(
  response: Response,
  options: DecodeOptions = {}
): AsyncGenerator<BaseEvent> {
  if (!response.ok) {
    throw new Error(`请求失败：${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('响应没有可读流（body 为空）')
  }

  // TextDecoderStream 而不是自己 new TextDecoder() 逐块解：
  // 一个多字节的中文字符完全可能被切在两个数据块之间，
  // 逐块独立解码会在边界上解出乱码。TextDecoderStream 内部会把半个字符留到下一块。
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()

  // 一个事件可能横跨多个数据块，所以要留一个缓冲区。
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        // 流正常结束时缓冲区里可能还剩最后一个没有尾随空行的事件。
        const tail = parseChunk(buffer, options)
        if (tail) yield tail
        return
      }

      buffer += value

      // 按空行切；最后一段可能是半个事件，留在缓冲区里等下一块。
      const parts = buffer.split(EVENT_SEPARATOR)
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        const event = parseChunk(part, options)
        if (event) yield event
      }
    }
  } finally {
    // 提前 break 出循环（比如用户打断）时必须释放锁，否则连接不会被回收。
    reader.releaseLock()
  }
}

/**
 * 解析一个 SSE 数据块。
 *
 * SSE 规范里 data: 可以有多行，多行之间用 \n 拼接；
 * 以冒号开头的是注释行（常用于心跳保活），要丢掉。
 */
function parseChunk(chunk: string, options: DecodeOptions): BaseEvent | null {
  const trimmed = chunk.trim()
  if (!trimmed) return null

  const dataLines: string[] = []

  for (const line of trimmed.split(/\r?\n/)) {
    // 注释行 / 心跳，直接忽略
    if (line.startsWith(':')) continue

    if (line.startsWith('data:')) {
      // 规范规定 data: 后面的第一个空格要去掉，其余保留
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    // event: / id: / retry: 字段本课用不到：事件类型写在 JSON 的 type 里，
    // 这样同一份事件定义在 SSE、WebSocket、批量回放三种传输下都能复用。
  }

  if (dataLines.length === 0) return null

  const raw = dataLines.join('\n')

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as BaseEvent).type !== 'string') {
      throw new Error('事件缺少 type 字段')
    }
    return parsed as BaseEvent
  } catch (error) {
    // 坏数据不能让整条流挂掉：跳过这一条，继续读下一条。
    const report =
      options.onMalformed ??
      ((badRaw: string, cause: unknown) => {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[agent] 丢弃无法解析的数据块', badRaw, cause)
        }
      })
    report(raw, error)
    return null
  }
}

/** 服务端用：把一个事件编码成一条 SSE 报文。 */
export function encodeEvent(event: BaseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}
