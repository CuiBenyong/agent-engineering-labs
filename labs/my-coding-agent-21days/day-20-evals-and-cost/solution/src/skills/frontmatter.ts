/**
 * SKILL.md 头部那段 YAML 的解析器。本天新增。
 *
 * **为什么不引 js-yaml。** 一是本课的零依赖纪律；二是更实际的理由：
 * 完整 YAML 的表达力远超技能元信息需要的那一点点，而多出来的表达力全是风险面——
 * 锚点、合并键、隐式类型转换（著名的 `no` 会被解析成布尔假），
 * 每一条都会让「同一份 SKILL.md 在两个客户端里行为不同」。
 *
 * 所以这里实现的是一个**明确的子集**，只认四种形状：
 *
 *   key: 裸标量          name: calc-conventions
 *   key: "带引号的标量"   description: "改 src/calc.js 时按这份约定来"
 *   key: [a, b, c]       triggers: [divide, 除零]
 *   key:                 paths:
 *     - a                  - src/calc.js
 *     - b                  - test/calc.test.js
 *
 * **红线只有一条：看不懂的行要报错，绝不猜。** 猜的代价是作者写错了却没人告诉他，
 * 于是他的技能安静地不触发——而这正是技能系统里最难查的一类故障。
 */

export type FieldValue = string | number | string[]

export interface Frontmatter {
  fields: Record<string, FieldValue>
  /** frontmatter 之后的全部内容，一个字节都不改 */
  body: string
}

export class FrontmatterError extends Error {}

const FENCE = '---'

/**
 * 把一份 SKILL.md 切成「头」与「正文」两段。
 *
 * 这个函数看起来该是一行 `text.split('---')`，而那一行是错的：
 * **Markdown 正文里 `---` 是合法的分隔线**，随便一篇稍长的文档就会有一条。
 * 按分隔符切会把正文切成碎片，表现是「技能全文莫名其妙少了一半」。
 * 正确做法是按行扫描，只认**第一行**与**其后第一条单独成行的 `---`**。
 */
export function splitFrontmatter(text: string): { head: string; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split('\n')
  if ((lines[0] ?? '').trim() !== FENCE) {
    throw new FrontmatterError('文件开头第一行必须是 ---')
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE)
  if (end === -1) throw new FrontmatterError('frontmatter 没有结束的 --- 那一行')
  return {
    head: lines.slice(1, end).join('\n'),
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, ''),
  }
}

export function parseFrontmatter(text: string): Frontmatter {
  const { head, body } = splitFrontmatter(text)
  return { fields: parseFields(head), body }
}

/** 解析头部那几行。缩进的 `- ` 行属于上一个键 */
function parseFields(head: string): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {}
  let listKey: string | null = null

  head.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '')
    const at = `第 ${index + 2} 行`
    if (line.trim() === '' || line.trim().startsWith('#')) return

    // 缩进的列表项：它属于上一个「只有键没有值」的键
    if (/^\s+-\s/.test(line)) {
      if (!listKey) throw new FrontmatterError(`${at} 是一个列表项，但它上面没有键`)
      ;(fields[listKey] as string[]).push(unquote(line.trim().slice(1).trim()))
      return
    }

    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) throw new FrontmatterError(`${at} 既不是「键: 值」也不是列表项：${line.trim()}`)
    const key = match[1] as string
    const rest = (match[2] as string).trim()

    if (rest === '') {
      // 只有键没有值：等下面的缩进列表项来填。空列表也是合法结果
      fields[key] = []
      listKey = key
      return
    }
    listKey = null
    fields[key] = rest.startsWith('[') ? parseInlineList(rest, at) : parseScalar(rest)
  })

  return fields
}

/** 行内数组：[a, b, "c, d"]。引号里的逗号不是分隔符，所以不能直接 split */
function parseInlineList(text: string, at: string): string[] {
  if (!text.endsWith(']')) throw new FrontmatterError(`${at} 的行内数组没有闭合的 ]`)
  const inner = text.slice(1, -1)
  const items: string[] = []
  let current = ''
  let quote = ''
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ',') {
      items.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (quote) throw new FrontmatterError(`${at} 的行内数组里有没闭合的引号`)
  if (current.trim() !== '') items.push(current.trim())
  return items.filter((item) => item !== '')
}

/**
 * 标量：去引号，纯数字转成数字。
 *
 * **只有纯数字才转**，别的一律当字符串——不做 YAML 那套隐式类型转换。
 * 一个 description 写成 `yes` 就变成布尔真，是没人想得到、也没人查得出的故障。
 */
function parseScalar(text: string): string | number {
  const value = unquote(text)
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value
}

function unquote(text: string): string {
  const first = text[0]
  if ((first === '"' || first === "'") && text.endsWith(first) && text.length >= 2) {
    return text.slice(1, -1)
  }
  return text
}
