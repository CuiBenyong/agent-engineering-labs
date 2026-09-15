/**
 * 让模型把一段对话写成摘要。本天新增。
 *
 * 两个决定：
 *
 * 一、**要结构化摘要，不要自由发挥。** 提示里写死四个小标题，模型只填内容。
 *    自由发挥的摘要读起来很顺，但它会把「已经改过 src/calc.js」写成
 *    「讨论了如何修复除零问题」——**动作变成了话题**，下一轮它就不知道自己已经动过手了。
 *    固定小标题的作用是逼它把动作、事实、待办分开放。
 *
 * 二、**压缩本身要花一次请求。** 摘要请求的输入就是那段要被压掉的对话，
 *    所以压缩不是免费的：它用一次「把旧上下文再发一遍」换来后面每一轮都少发一遍。
 *    这也是压缩不能太频繁的原因——压一次的成本是固定的，收益要靠后面的轮数摊。
 *
 * 这一处直接调 provider.stream，不走 Agent Loop：摘要是一次不带工具、不需要审批、
 * 不该被记进会话日志的单轮请求，套上循环那一整套只会引来一堆不相干的分支。
 */
import type { ChatProvider } from '../providers/types.js'
import type { Message } from '../kernel/types.js'
import { contentToText } from '../kernel/types.js'

/** 摘要请求里单条消息最多带多少字符：转录本身也要发出去，不能无上限 */
export const TRANSCRIPT_MESSAGE_CHARS = 2000

/** 摘要的四个小标题。它是**协议**：探针与自检都按这四行找东西 */
export const SUMMARY_HEADINGS = [
  '已确认的事实：',
  '已做过的改动：',
  '未完成的事情：',
  '关键路径与命令：',
]

export const SUMMARY_SYSTEM =
  '你在压缩一段对话记录，压缩结果会替换掉原文继续参与后面的对话。' +
  `严格按这四个小标题输出，一个都不许少、也不要写别的：${SUMMARY_HEADINGS.join('')}` +
  '每条一行，用「- 」开头。' +
  '所有内容必须来自记录原文，不许推测、不许补全——宁可某一节写「无」，也不要编。'

/** 转录的开头这句话是给离线剧本认的标记，也是给模型的任务说明 */
export const TRANSCRIPT_PREFIX = '以下是需要压缩的一段对话记录，请按固定小标题写摘要。'

/**
 * 把一段消息转录成纯文本。
 *
 * 角色要显式标出来（`【user】`），否则模型分不清哪句是用户说的、哪句是工具吐的——
 * 而这两者的可信度完全不同：用户说的是需求，工具吐的是事实，助手说的是推测。
 */
export function renderTranscript(messages: Message[]): string {
  const rows = messages.map((message) => {
    const who =
      message.role === 'tool' ? `tool:${message.name ?? '未知'}` : (message.role as string)
    const body = contentToText(message.content).slice(0, TRANSCRIPT_MESSAGE_CHARS)
    const calls = (message.toolCalls ?? []).map((c) => `${c.name}(${c.args.slice(0, 200)})`)
    const tail = calls.length > 0 ? `\n  调用了：${calls.join('、')}` : ''
    return `【${who}】${body}${tail}`
  })
  return `${TRANSCRIPT_PREFIX}\n\n${rows.join('\n')}`
}

/** 摘要文本里是不是四个小标题都在。缺标题说明模型没照格式写，调用方要据此决定放不放弃 */
export function looksStructured(summary: string): boolean {
  return SUMMARY_HEADINGS.every((heading) => summary.includes(heading))
}

export async function summarizeSegment(
  provider: ChatProvider,
  messages: Message[],
  signal?: AbortSignal
): Promise<string> {
  const request = {
    messages: [
      { role: 'system' as const, content: SUMMARY_SYSTEM },
      { role: 'user' as const, content: renderTranscript(messages) },
    ],
    ...(signal ? { signal } : {}),
  }

  let text = ''
  for await (const delta of provider.stream(request)) {
    if (delta.type === 'text') text += delta.text
  }
  return text.trim()
}
