/**
 * 两个出口的形状：发给网关的报文，与写进会话日志的那一条。本天新增。
 *
 * 第一天把 Message.content 定成 `string | ContentPart[]` 的时候，写的注释是
 * 「D19 才会用到数组形态」。今天用到了，而真正要改的**只有出口这一层**：
 * 循环、审批、截断、快照、压缩一行都不用动，因为它们碰的是 ContentPart 这个协议，
 * 不是网关的报文。**协议层与线协议分开，省下的就是今天这一堆不用改的代码。**
 *
 * 两个出口的规矩正好相反，这一点值得停一下：
 *   - 发给网关：**图片要原样带上**，那是这一轮的信息本体
 *   - 写进日志：**图片正文一个字节都不进去**，留一行说明就够
 * 同一条消息，两个出口给出两种投影——因为它们要回答的问题不同。
 */
import type { ContentPart, Message } from '../kernel/types.js'
import { contentToText } from '../kernel/types.js'

/**
 * 线协议映射。OpenAI 兼容网关收的图片形状是
 * `{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }`
 * （2026-09-07 实测跑通），文字段是 `{ type: "text", text }`。
 *
 * **纯文本消息仍然发成一个字符串，而不是只有一段文字的数组。** 两种写法对面都认，
 * 但改成数组会让每一条历史消息的字节形状都变一遍——提示缓存是按前缀命中的，
 * 为一个用不上的统一性去动它不划算。
 */
export function toWireContent(
  content: string | ContentPart[]
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!content.some((part) => part.type === 'image')) return contentToText(content)
  // TODO(4)：把数组翻译成网关认的形状。
  //   文字段  { type: 'text', text }
  //   图片段  { type: 'image_url', image_url: { url: 'data:<mediaType>;base64,<base64>' } }
  // 这两个形状 2026-09-07 实测跑通过，逐字照抄，不要自己发明字段名。
  return contentToText(content)
}

/** 一条消息的完整线协议形状。网关那一层把 content 换成它就接上了 */
export function toWireMessage(message: Message): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: message.role,
    content: toWireContent(message.content),
  }
  if (message.toolCallId) base.tool_call_id = message.toolCallId
  if (message.name) base.name = message.name
  if (message.toolCalls?.length) {
    base.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    }))
  }
  return base
}

/**
 * 写进会话日志之前的投影：把图片正文换成一行说明。
 *
 * 不这么做的后果很具体：一张几百 KB 的截图，base64 之后是几十万字符，
 * 它会原样躺进 `work/sessions/<id>.jsonl` 的一行里。三五轮之后这个文件就没法读、
 * 没法 diff、`--resume` 要先把它整个读回内存。**日志是给人看和给恢复用的，
 * 不是图片仓库。**
 *
 * 代价要说清楚：**恢复出来的会话里没有那张图了。** 这是有意的取舍——
 * 截图是一次性的输入，它的结论已经变成后面的对话与真实的代码改动；
 * 真要再看一眼，原图还在 work/shots 里，重新 @ 一次就是了。
 */
export function forLog(message: Message): Message {
  if (typeof message.content === 'string') return message
  if (!message.content.some((part) => part.type === 'image')) return message
  let index = 0
  const parts = message.content.map((part) => {
    if (part.type === 'text') return part
    index += 1
    const chars = part.base64.length
    return {
      type: 'text' as const,
      text: `[截图 ${index}：${part.mediaType}，base64 ${chars} 字符，正文未入日志]`,
    }
  })
  return { ...message, content: parts }
}
