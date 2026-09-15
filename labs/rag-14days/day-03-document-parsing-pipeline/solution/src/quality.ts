import type { ParsedDoc, ParsedNode } from './types.js'

/**
 * 解析质量断言。
 *
 * 这一组函数是本天最该带走的东西：**解析是一条没人盯着的流水线**，
 * 语料一多就没人去逐篇看解析结果，坏数据会安安静静地躺进索引里，
 * 直到某天有人问了一个问题、拿到一段串行的表格才被发现。
 * 所以每一条解析结果都要过一遍可断言的检查，越线就报警、就拦住入库。
 */

export interface Check {
  name: string
  value: string
  limit: string
  ok: boolean
}

/** 空文本比例：节点太短或者干脆没有节点。最典型的成因是扫描件没有文本层 */
export function emptyRatio(nodes: ParsedNode[]): number {
  if (nodes.length === 0) return 1
  const short = nodes.filter((n) => n.text.trim().length < 4).length
  return short / nodes.length
}

/**
 * 表格塌陷：一张 Markdown 风格的表被解析成了对不上的形状。
 * 两种典型形态：整张表挤成一行，或者各行的竖线数量不一致（导出时丢了分隔符）。
 */
export function detectCollapsedTable(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim())
  const tableLines = lines.filter((l) => (l.match(/\|/g)?.length ?? 0) >= 2)
  if (tableLines.length === 0) return false
  if (tableLines.length === 1) return true // 整张表塌成一行
  const widths = new Set(tableLines.map((l) => l.split('|').length))
  return widths.size > 1 // 各行列数对不上，就是串行了
}

export function countCollapsedTables(nodes: ParsedNode[]): number {
  return nodes.filter((n) => detectCollapsedTable(n.text)).length
}

/**
 * 术语命中数：拿文档标题切出来的二元组当探针，数它们在解析结果里出现了多少次。
 * 这是一个粗糙但零成本的信号——同一篇文档换一条解析路径之后命中数掉了一大截，
 * 说明这条路径把字弄丢了或者弄错了（OCR 错字就是这么被看出来的）。
 */
export function probeHits(title: string, text: string): number {
  const terms = new Set<string>()
  for (const seg of title.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 1 < seg.length; i += 1) terms.add(seg.slice(i, i + 2))
  }
  let hits = 0
  for (const term of terms) hits += text.split(term).length - 1
  return hits
}

/**
 * 把解析结果拼回一段连续文本：标题按首次出现算一次，后面跟各节点正文。
 * 用它来做跨来源比较，避免「标题路径在每个节点里重复一遍」把命中数灌水。
 */
export function reconstruct(doc: ParsedDoc): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const node of doc.nodes) {
    for (const heading of node.headingPath) {
      if (heading && !seen.has(heading)) {
        seen.add(heading)
        parts.push(heading)
      }
    }
    parts.push(node.text)
  }
  return parts.join('')
}

export interface QualityInput {
  doc: ParsedDoc
  /** 只有 PDF 来源算得出来，其余来源传 0 */
  orderSuspicion?: number
}

/** 三条线是拍出来的经验值，换一份语料就该重新校一次——重要的是有线，不是线在哪 */
export const LIMITS = { emptyRatio: 0.2, orderSuspicion: 0.15, collapsedTables: 0 }

export function runChecks({ doc, orderSuspicion = 0 }: QualityInput): Check[] {
  const empty = emptyRatio(doc.nodes)
  const collapsed = countCollapsedTables(doc.nodes)
  return [
    {
      name: '空文本比例',
      value: empty.toFixed(2),
      limit: `≤ ${LIMITS.emptyRatio}`,
      ok: empty <= LIMITS.emptyRatio,
    },
    {
      name: '乱序疑似度',
      value: orderSuspicion.toFixed(2),
      limit: `≤ ${LIMITS.orderSuspicion}`,
      ok: orderSuspicion <= LIMITS.orderSuspicion,
    },
    {
      name: '塌陷表格数',
      value: String(collapsed),
      limit: `= ${LIMITS.collapsedTables}`,
      ok: collapsed <= LIMITS.collapsedTables,
    },
  ]
}
