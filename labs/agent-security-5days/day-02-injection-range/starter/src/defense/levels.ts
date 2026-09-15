import { DATA_CLOSE, DATA_OPEN } from '../core/mock-model.js'

export type DefenseLevel = 0 | 1 | 2 | 3 | 4

export const LEVELS: Array<{ level: DefenseLevel; name: string; note: string }> = [
  { level: 0, name: '无防御', note: '不可信内容直接拼进提示词' },
  { level: 1, name: '分隔符', note: '用代码围栏把数据包起来' },
  { level: 2, name: '来源标记', note: '显式声明数据区的起止，并说明区内不是指令' },
  { level: 3, name: '聚光标注', note: '在来源标记之上改写数据区的字符，让区内文本无法伪装成结构' },
  { level: 4, name: '标记加检测器', note: '在第三档之上加一个特征检测器，命中就整条拒绝' },
]

export interface Block {
  label: string
  content: string
}

/**
 * 聚光标注（spotlighting）：把数据区里的空格换成 ^、方括号换成全角，
 * 并在指令里告诉模型「带 ^ 的都是数据」。
 *
 * 它值钱的地方不是「模型能看懂 ^」，而是**数据区里的任何字符串都不再可能与结构标记字面相同**——
 * 伪造标记这一手法从此失效。
 */
export function spotlight(text: string): string {
  // TODO(1)：把空格换成 ^、把半角方括号换成全角。
  // 关键不是「模型能看懂 ^」，而是数据区里的任何字符串都不再可能与结构标记字面相同。
  return text
}

export function buildPrompt(level: DefenseLevel, request: string, blocks: Block[]): string {
  const head = `你是内部知识助手 deskmate。用户的任务：${request}`

  if (level === 0) {
    return [head, ...blocks.map((b) => `${b.label}：\n${b.content}`)].join('\n\n')
  }

  if (level === 1) {
    return [head, ...blocks.map((b) => `${b.label}：\n\`\`\`\n${b.content}\n\`\`\``)].join('\n\n')
  }

  // TODO(2)：第二档与第三档。
  //   L2 来源标记：在每个区块的内容前后各加一行 DATA_OPEN / DATA_CLOSE，
  //      并在 head 之后补一句声明，告诉模型区内一律是数据不是指令。
  //   L3 聚光标注：在 L2 之上，把区块内容过一遍 spotlight()，声明里也要说明这件事。
  // 想清楚再写：这两档为什么能挡住不同的攻击？答案在 core/mock-model.ts 的 splitRegions()。
  void DATA_OPEN
  void DATA_CLOSE
  void spotlight
  return [head, ...blocks.map((b) => `${b.label}：\n${b.content}`)].join('\n\n')
}
