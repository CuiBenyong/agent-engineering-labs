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

  // 【练习 1】把字节流解成字符串流。
  //
  // 提示：不要自己 new TextDecoder() 然后逐块 decode ——
  // 一个中文字符占 3 个字节，完全可能被切在两个数据块之间，
  // 逐块独立解码会在边界上解出「空白菱形问号」那种乱码。
  // 自检里有一条断言专门制造这种切分，做错了会红。
  const reader = response.body.pipeThrough(/* TODO */ new TransformStream()).getReader()

  // 【练习 2】一个事件可能横跨多个数据块，按空行切分并处理跨块的半个事件。
  //
  // 循环要点：
  //   - reader.read() 返回 { done, value }
  //   - 把 value 累加到缓冲区，用 EVENT_SEPARATOR 切开
  //   - 切出来的最后一段可能是半个事件，要留在缓冲区里等下一块
  //   - done 的时候缓冲区里可能还剩最后一个没有尾随空行的事件
  //   - finally 里要 reader.releaseLock()，否则提前 break 会让连接不被回收
  let buffer = ''
  void buffer
  void reader

  throw new Error('TODO: 实现解码循环')
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

  // 【练习 3】按 SSE 规范取出 data 字段。
  //   - 以冒号开头的是注释行（心跳保活），要丢掉
  //   - data: 可以有多行，多行之间用 \n 拼接
  //   - data: 后面的第一个空格要去掉，其余保留
  const dataLines: string[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    void line
    // TODO
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
