/**
 * SSE 增量解析器：与 UI 框架无关的纯逻辑，所以能单独测。
 *
 * 为什么不用 EventSource：它只能发 GET、不能带自定义头（Authorization 放不进去）、
 * 不能带请求体。所以走 fetch + ReadableStream，代价就是这一段得自己写。
 */

/** 一帧 SSE 解出来的形状。 */
export interface SseFrame {
  /** SSE 的 id 字段。本课约定它就是 D11 那个 seq。 */
  id?: string
  event: string
  data: string
}

/**
 * 创建一个有状态的解析器：喂任意切分的字符串块，吐出这一块里能凑齐的完整帧。
 *
 * 关键是 buffer：网络不保证一块正好是一帧，半帧要留到下一轮再拼。
 * D1 讲的是「半行」，这里是「半帧」——同一件事，边界从 \n 换成了 \n\n。
 */
export function createSseParser(): (chunk: string) => SseFrame[] {
  // 练习 1：这个版本没有跨块缓冲——它假设每一块都恰好是若干个完整的帧。
  //   本机直连时它多半"能用"，一上弱网、一过代理，被切成两半的帧就整帧丢失。
  //   请改成：用一个 buffer 累积，只切出完整的帧（以 "\n\n" 结尾），
  //   剩下的半帧留到下一轮再拼。
  //   提示：这就是 D1 那个半行缓冲，只是边界从 "\n" 换成了 "\n\n"。
  return (chunk: string): SseFrame[] => {
    const frames: SseFrame[] = []
    for (const raw of chunk.replace(/\r\n/g, '\n').split('\n\n')) {
      const frame = parseFrame(raw)
      if (frame) frames.push(frame)
    }
    return frames
  }
}

/** 把一帧的原文（不含结尾空行）解成字段。冒号开头的注释行就是心跳，安静忽略。 */
function parseFrame(raw: string): SseFrame | null {
  let id: string | undefined
  let event = 'message'
  const dataLines: string[] = []

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    // 规范规定字段值前的一个空格要吃掉，多余的空格属于内容
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }

  // 只有心跳（纯注释）的帧没有 data，不算一帧事件
  if (dataLines.length === 0) return null
  return { id, event, data: dataLines.join('\n') }
}
