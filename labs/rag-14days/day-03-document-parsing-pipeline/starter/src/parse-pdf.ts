import type { Doc } from './corpus.js'
import { pushHeading } from './parse-md.js'
import { chunkId, contentHash, type ParsedDoc, type ParsedNode } from './types.js'

/**
 * PDF 的文本层拿到手是这样一条条记录：某一页、某个坐标、某个字号、某一小段文字。
 * **PDF 里没有「段落」，也没有「阅读顺序」**——这两样都得你自己从坐标里推回来。
 */
export interface TextRun {
  page: number
  x: number
  y: number
  size: number
  text: string
}

/** 页眉页脚的位置是固定的，按 y 值直接划出上下两条带 */
const HEADER_Y = 800
const FOOTER_Y = 60

function decodeHex(hex: string): string {
  const body = hex.startsWith('FEFF') || hex.startsWith('feff') ? hex.slice(4) : hex
  const units: number[] = []
  for (let i = 0; i + 3 < body.length; i += 4) units.push(parseInt(body.slice(i, i + 4), 16))
  return String.fromCharCode(...units)
}

/**
 * 从 PDF 内容流里抽出文本片段。真实的 pdf 库（pdfjs、pdfplumber）给你的也是这个形状，
 * 只是它们还要处理字体编码、变换矩阵、旋转页面等一堆情况。
 */
export function extractRuns(pdf: Buffer): TextRun[] {
  const raw = pdf.toString('latin1')
  const runs: TextRun[] = []
  const streams = raw.split(/\bstream\r?\n/).slice(1)
  streams.forEach((chunk, index) => {
    const body = chunk.split(/\r?\nendstream/)[0]
    const re = /BT\s*\/F1 ([\d.]+) Tf\s*1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*<([0-9A-Fa-f]+)> Tj\s*ET/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      runs.push({
        page: index + 1,
        size: Number(m[1]),
        x: Number(m[2]),
        y: Number(m[3]),
        text: decodeHex(m[4]),
      })
    }
  })
  return runs
}

/** 页眉页脚：按位置剔除，并把剔掉的条数报出来，方便你确认没误伤正文 */
export function splitChrome(runs: TextRun[]): { body: TextRun[]; chrome: TextRun[] } {
  const body: TextRun[] = []
  const chrome: TextRun[] = []
  for (const run of runs) (run.y > HEADER_Y || run.y < FOOTER_Y ? chrome : body).push(run)
  return { body, chrome }
}

/**
 * 找分栏边界：把一页里所有文本片段的左边界排序，看有没有一条足够宽的空隙。
 * 有，且两边都有像样的文字量，就判定为双栏，返回分界线的 x。
 */
export function detectColumnBoundary(pageRuns: TextRun[]): number | null {
  const xs = [...new Set(pageRuns.map((r) => Math.round(r.x)))].sort((a, b) => a - b)
  let best = { gap: 0, left: 0, right: 0 }
  for (let i = 1; i < xs.length; i += 1) {
    const gap = xs[i] - xs[i - 1]
    if (gap > best.gap) best = { gap, left: xs[i - 1], right: xs[i] }
  }
  if (best.gap < 60) return null
  const boundary = (best.left + best.right) / 2
  const rightCount = pageRuns.filter((r) => r.x >= boundary).length
  const ratio = rightCount / pageRuns.length
  // 两边都要有 15% 以上的内容，否则那条「空隙」多半只是一个缩进或者一张图的标注
  return ratio > 0.15 && ratio < 0.85 ? boundary : null
}

export function columnOf(run: TextRun, boundary: number | null): number {
  return boundary === null || run.x < boundary ? 0 : 1
}

/**
 * 阅读顺序：先分页，再分栏，栏内从上往下。
 * PDF 内容流里的顺序**不可信**——排版软件常按 y 值成带地写，双栏文档写出来就是
 * 左一行右一行地交替，直接照抄会把两栏的句子拌在一起。
 */
export function sortRuns(runs: TextRun[]): TextRun[] {
  // 练习 2：把文本片段排成人读的顺序。
  // 提示：先按 page 分组，每页用 detectColumnBoundary 判断是不是双栏，
  //       再按「栏号 → y 从大到小 → x 从小到大」排序（columnOf 已经写好了）。
  // 现在直接返回内容流原序，双栏那份 PDF 会被拌成一锅：
  // 乱序疑似度会顶到 0.3 以上，段落被拆成一行一行的碎片。
  return runs
}

/**
 * 乱序疑似度：顺着排好的阅读顺序走一遍，统计「往回跳」的比例。
 * 同一栏里 y 变大（往页面上方跳）、或者从右栏跳回左栏，都算一次可疑。
 * 这是一个不需要标准答案就能算出来的指标——**它不告诉你顺序对不对，
 * 只告诉你顺序像不像人读出来的**，越线就该去看那一页。
 */
export function orderSuspicion(ordered: TextRun[]): number {
  const boundaries = new Map<number, number | null>()
  for (const run of ordered) {
    if (!boundaries.has(run.page)) {
      boundaries.set(run.page, detectColumnBoundary(ordered.filter((r) => r.page === run.page)))
    }
  }
  let pairs = 0
  let bad = 0
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]
    const cur = ordered[i]
    if (prev.page !== cur.page) continue
    pairs += 1
    const boundary = boundaries.get(cur.page) ?? null
    const prevCol = columnOf(prev, boundary)
    const curCol = columnOf(cur, boundary)
    if (curCol < prevCol) bad += 1
    else if (curCol === prevCol && cur.y > prev.y + 1) bad += 1
  }
  return pairs === 0 ? 0 : bad / pairs
}

export interface PdfParseResult extends ParsedDoc {
  chromeDropped: number
  orderSuspicion: number
  pageCount: number
}

export function parsePdf(doc: Doc, pdf: Buffer, order = sortRuns): PdfParseResult {
  const hash = contentHash(pdf.toString('latin1'))
  const all = extractRuns(pdf)
  const { body, chrome } = splitChrome(all)
  const ordered = order(body)

  const nodes: ParsedNode[] = []
  let headingPath: string[] = []
  let buffer: TextRun[] = []

  const flush = () => {
    if (buffer.length === 0) return
    const text = buffer.map((r) => r.text).join('')
    const first = buffer[0]
    buffer = []
    nodes.push({
      docId: doc.id,
      chunkId: chunkId(doc.id, nodes.length),
      text,
      headingPath: [...headingPath],
      page: first.page, // 只有 PDF 来源填页码，D6 的引用要靠它指回原文
      department: doc.department,
      updatedAt: doc.updated,
      contentHash: hash,
    })
  }

  let prev: TextRun | null = null
  for (const run of ordered) {
    // PDF 里没有「标题」标记，只能靠字号认：比正文大就是标题
    if (run.size >= 13) {
      flush()
      headingPath = pushHeading(headingPath, run.size >= 16 ? 1 : 2, run.text)
      prev = run
      continue
    }
    const broken =
      prev === null ||
      prev.page !== run.page ||
      prev.size >= 13 ||
      Math.abs(prev.x - run.x) > 5 ||
      Math.abs(prev.y - run.y) > run.size * 2
    if (broken) flush()
    buffer.push(run)
    prev = run
  }
  flush()

  return {
    docId: doc.id,
    title: doc.title,
    source: 'pdf',
    department: doc.department,
    updatedAt: doc.updated,
    contentHash: hash,
    nodes,
    chromeDropped: chrome.length,
    orderSuspicion: orderSuspicion(ordered),
    pageCount: new Set(all.map((r) => r.page)).size,
  }
}
