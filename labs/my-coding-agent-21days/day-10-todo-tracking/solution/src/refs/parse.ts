/**
 * 引用语法的解析。本天新增。
 *
 * 语法只有一个符号：`@` 后面跟一个路径、通配符或者网址。看着简单，
 * 但它要处理的是**人随手打出来的东西**，所以四种情况一个都不能漏：
 *
 *   1. 邮箱不是引用。`eric@example.com` 里的 @ 前面是字母，不是分隔符——
 *      判据是「@ 必须在开头或者紧跟空白」，不是「文本里有没有 @」。
 *   2. 要能转义。`\@src` 表示我真的想说 @src 这几个字，别去读文件。
 *   3. 路径里有空格就得能引起来：`@"src/my file.js"`。
 *   4. 标点会粘在后面，而且分两种。中文标点（`看看 @src/calc.js。还有…`）是**硬终止符**：
 *      路径里不会出现它，遇到就停。ASCII 的点与逗号不能当终止符（`calc.js` 自己就带点），
 *      只能在末尾出现时剥掉。斜杠反过来要留着——它是目录的标记。
 *
 * 解析结果保留每条引用在原文里的位置（start 与 end）。为什么要留：
 * **用户的原话一个字都不改。** 引用内容作为另一条消息注入，原话里那个 `@src/calc.js`
 * 原样留着——它对模型是一个指针，模型回答时会引用它，用户也能对得上自己写的东西。
 */

/** 三种形态：网址、通配符、普通路径。路径到底是文件还是目录，要看磁盘才知道 */
export type RefKind = 'url' | 'glob' | 'path'

export interface Reference {
  kind: RefKind
  /** 引用的目标：路径或者网址，已经去掉引号与尾部标点 */
  target: string
  /** 在原文里的原样片段，含 @ */
  raw: string
  start: number
  end: number
}

/**
 * 硬终止符：出现就停。全是中日韩标点与全角括号——路径里不会有它们，
 * 而人写中文时一定会把它们紧贴在路径后面。
 */
const TERMINATORS = new Set([
  '。',
  '，',
  '、',
  '；',
  '：',
  '！',
  '？',
  '（',
  '）',
  '「',
  '」',
  '『',
  '』',
  '…',
])

/**
 * 只在末尾剥掉的字符。ASCII 的点、逗号、冒号**不能**当终止符——
 * `calc.js` 自己就带一个点。注意斜杠两张表里都没有：它是目录的标记，要留着。
 */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '"', "'"])

export function parseReferences(text: string): Reference[] {
  const refs: Reference[] = []

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') continue
    // 转义：前一个字符是反斜杠就跳过（原文里的 \@ 到了展开那一步会被还原成 @）
    if (text[i - 1] === '\\') continue
    // @ 必须在开头或者紧跟空白，否则它是邮箱、装饰器、用户名的一部分
    if (i > 0 && !/\s/.test(text[i - 1] as string)) continue

    const parsed = readTarget(text, i + 1)
    if (!parsed) continue
    refs.push({
      kind: classify(parsed.target),
      target: parsed.target,
      raw: text.slice(i, parsed.end),
      start: i,
      end: parsed.end,
    })
    i = parsed.end - 1
  }

  return refs
}

/** 从 @ 后面读出目标。支持引号包裹；不带引号时读到空白为止再剥尾部标点 */
function readTarget(text: string, from: number): { target: string; end: number } | null {
  const quote = text[from]
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, from + 1)
    // 引号没闭合：当成没写完，不猜
    if (close === -1) return null
    const target = text.slice(from + 1, close)
    return target ? { target, end: close + 1 } : null
  }

  let end = from
  // 读到空白或者硬终止符为止
  while (end < text.length) {
    const ch = text[end] as string
    if (/\s/.test(ch) || TERMINATORS.has(ch)) break
    end += 1
  }
  // 再剥掉末尾的 ASCII 标点，但斜杠留着——它是目录的标记
  while (end > from && TRAILING.has(text[end - 1] as string)) end -= 1
  const target = text.slice(from, end)
  return target ? { target, end } : null
}

function classify(target: string): RefKind {
  if (/^https?:\/\//i.test(target)) return 'url'
  if (target.includes('*') || target.includes('?')) return 'glob'
  return 'path'
}

/** 把原文里的 \@ 还原成 @。用户输入里的转义不该带进发给模型的文本 */
export function unescapeAt(text: string): string {
  return text.replace(/\\@/g, '@')
}
