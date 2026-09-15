/**
 * 增量 Markdown：容忍「语法只来了一半」的渲染器。
 *
 * 流式渲染 Markdown 的难点不是解析 Markdown，而是解析**不完整的** Markdown。
 * 模型吐到一半时，你手里的文本可能是：
 *
 *   这是一段代码：
 *   ```ts
 *   const a = 1
 *
 * 围栏开了还没关。直接交给普通解析器，它要么把后面所有内容都当成代码块，
 * 要么干脆不认这个块——两种都会让画面在流结束的瞬间突然重排一次，非常刺眼。
 *
 * 本课的做法：把文本切成块之前，先补上缺的收尾标记，让「正在生成中」的语法
 * 以它最终会变成的样子渲染。这样内容完成时画面不会跳。
 *
 * 刻意不引入 markdown 库：这门课的重点就是理解这件事为什么难。
 * 支持的子集是聊天里真正高频的那几种：围栏代码块、行内码、粗体、标题、列表。
 */

export type MarkdownBlock =
  | { kind: 'code'; language: string; text: string; complete: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: string[]; ordered: boolean }
  | { kind: 'paragraph'; text: string }

const FENCE = /^(`{3,})(.*)$/

/**
 * 把流式文本切成块。
 *
 * complete 为 false 的代码块表示围栏还没闭合——界面据此显示「还在写」的样式，
 * 并且**不要**对它做语法高亮（见下面的两趟渲染说明）。
 */
export function parseIncrementalMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE.exec(line.trim())

    // --- 围栏代码块 ---
    if (fence) {
      const marker = fence[1]
      const language = fence[2].trim().split(/\s+/)[0] ?? ''
      const body: string[] = []
      let complete = false

      i += 1
      while (i < lines.length) {
        const candidate = lines[i].trim()
        // 收栏行：同样的字符、不短于开栏
        if (candidate.startsWith(marker[0].repeat(marker.length))) {
          complete = true
          i += 1
          break
        }
        body.push(lines[i])
        i += 1
      }

      blocks.push({ kind: 'code', language, text: body.join('\n'), complete })
      continue
    }

    // --- 标题 ---
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      i += 1
      continue
    }

    // --- 列表 ---
    const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (bullet) {
      const ordered = /\d/.test(bullet[1])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i])
        if (!m) break
        items.push(m[2])
        i += 1
      }
      blocks.push({ kind: 'list', items, ordered })
      continue
    }

    // --- 段落（连续非空行）---
    if (line.trim() === '') {
      i += 1
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !FENCE.test(lines[i].trim())) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }

  return blocks
}

export type InlineToken =
  { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'strong'; text: string }

/**
 * 行内标记的增量解析。
 *
 * 关键取舍：遇到只开了口没闭合的标记（比如结尾是「**未完」），
 * 把它**当成普通文本**渲染，而不是提前加粗。
 *
 * 理由：加粗一半的文字在流式过程中会一闪一闪，而普通文本转成粗体只跳一次。
 * 少跳一次总是更好的那个选择。
 */
export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let rest = source

  const patterns: Array<{ re: RegExp; kind: InlineToken['kind'] }> = [
    { re: /^`([^`]+)`/, kind: 'code' },
    { re: /^\*\*([^*]+)\*\*/, kind: 'strong' },
  ]

  let buffer = ''

  while (rest.length > 0) {
    let matched = false

    for (const { re, kind } of patterns) {
      const m = re.exec(rest)
      if (m) {
        if (buffer) {
          tokens.push({ kind: 'text', text: buffer })
          buffer = ''
        }
        tokens.push({ kind, text: m[1] } as InlineToken)
        rest = rest.slice(m[0].length)
        matched = true
        break
      }
    }

    if (!matched) {
      buffer += rest[0]
      rest = rest.slice(1)
    }
  }

  // 收尾：没闭合的标记留在 buffer 里，作为普通文本输出。
  if (buffer) tokens.push({ kind: 'text', text: buffer })

  return tokens
}
