import { parse } from 'node-html-parser'
import type { Doc } from './corpus.js'
import { pushHeading } from './parse-md.js'
import { chunkId, contentHash, type ParsedDoc, type ParsedNode } from './types.js'

/**
 * 进正文之前先整块丢掉的东西。**这一步是「清洗的边界」里删得最狠的一刀**：
 * 导航、侧栏、页脚、脚本在每一页都长得一模一样，留着会让它们在所有文档里
 * 高频出现，检索时既拉低区分度，又会把用户带到一段毫无信息量的文字上。
 */
const DROP = ['script', 'style', 'nav', 'footer', 'aside', 'noscript', 'header']

/** 保留下来的块级元素，按文档顺序遍历 */
const KEEP = 'h1, h2, h3, h4, h5, h6, p, pre, ul, ol, table, blockquote'

function normalize(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function parseHtml(doc: Doc, html: string): ParsedDoc {
  const hash = contentHash(html)
  const root = parse(html)

  for (const selector of DROP) {
    for (const el of root.querySelectorAll(selector)) el.remove()
  }

  // 相对链接：href 本身是元数据，直接丢掉之后就再也追不回来了。
  // 这里把它内联进文本，既不丢信息，也不需要额外的字段。
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    const label = a.text.trim()
    if (!href || href.startsWith('#') || /^https?:/i.test(href)) continue
    a.textContent = `${label}（链接：${href}）`
  }

  const nodes: ParsedNode[] = []
  let headingPath: string[] = []

  for (const el of root.querySelectorAll(KEEP)) {
    const tag = el.tagName.toLowerCase()
    const heading = /^h([1-6])$/.exec(tag)
    if (heading) {
      headingPath = pushHeading(headingPath, Number(heading[1]), normalize(el.text))
      continue
    }
    // 列表整块保留：一条 li 单独拿出来往往看不懂，合起来才是一个语义单元
    const text =
      tag === 'ul' || tag === 'ol'
        ? el
            .querySelectorAll('li')
            .map((li) => `- ${normalize(li.text)}`)
            .join('\n')
        : tag === 'pre'
          ? el.text.replace(/\s+$/, '') // 代码块保留换行与缩进，normalize 会把它揉平
          : normalize(el.text)

    nodes.push({
      docId: doc.id,
      chunkId: chunkId(doc.id, nodes.length),
      text,
      headingPath: [...headingPath],
      page: null,
      department: doc.department,
      updatedAt: doc.updated,
      contentHash: hash,
    })
  }

  return {
    docId: doc.id,
    title: doc.title,
    source: 'html',
    department: doc.department,
    updatedAt: doc.updated,
    contentHash: hash,
    nodes,
  }
}
