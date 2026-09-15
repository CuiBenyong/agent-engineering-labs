import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAB_ROOT, getDoc, loadCorpus, type Doc } from './corpus.js'

/**
 * 样例生成器：把语料里的 Markdown 原件渲染成 HTML / PDF / 扫描件文本，
 * 供解析器练手。**不下载任何外部文件**——版权干净，而且离线可复现。
 *
 * 这个文件属于「造夹具」，不是当天的教学重点，快速扫一眼知道它造了什么就行。
 */

export const SAMPLES_DIR = join(LAB_ROOT, 'samples')

// ---------------------------------------------------------------- PDF 写入

const PAGE_W = 595
const PAGE_H = 842
const MARGIN = 50
const TOP_Y = 780
const BOTTOM_Y = 90
const LEADING = 15
const COL_GAP = 25

export interface Block {
  /** 字号：正文 10，二级标题 14，一级标题 17。PDF 里没有「标题」这个概念，只有字号 */
  size: number
  text: string
}

interface PlacedRun {
  x: number
  y: number
  size: number
  text: string
}

/** 按字号估算一行能放多少字符，中英混排下够用 */
function wrap(text: string, size: number, width: number): string[] {
  const perLine = Math.max(8, Math.floor(width / (size * 0.98)))
  const lines: string[] = []
  for (let i = 0; i < text.length; i += perLine) lines.push(text.slice(i, i + perLine))
  return lines.length > 0 ? lines : ['']
}

/**
 * 把块排进 1 栏或 2 栏的版面。返回每页的文本片段列表。
 * 注意最后一步的排序：**同一页内按 y 从上往下、同 y 再按 x 排**——
 * 这正是真实排版软件写内容流的常见顺序，也是多栏 PDF 阅读顺序问题的根源。
 */
function layout(blocks: Block[], columns: number, linesPerColumn: number): PlacedRun[][] {
  const colWidth = columns === 1 ? PAGE_W - MARGIN * 2 : (PAGE_W - MARGIN * 2 - COL_GAP) / columns
  const colX = Array.from({ length: columns }, (_, i) => MARGIN + i * (colWidth + COL_GAP))

  const pages: PlacedRun[][] = [[]]
  let col = 0
  let y = TOP_Y
  let used = 0

  const newColumn = () => {
    col += 1
    if (col >= columns) {
      col = 0
      pages.push([])
    }
    y = TOP_Y
    used = 0
  }

  for (const block of blocks) {
    const lines = wrap(block.text, block.size, colWidth)
    if (used + lines.length > linesPerColumn) newColumn()
    for (const line of lines) {
      if (used >= linesPerColumn || y < BOTTOM_Y) newColumn()
      pages[pages.length - 1].push({ x: colX[col], y, size: block.size, text: line })
      y -= LEADING
      used += 1
    }
    y -= LEADING * 0.6 // 段间距
  }

  return pages.map((runs, i) => {
    const withChrome = [
      { x: MARGIN, y: 805, size: 8, text: '云梯科技 · 内部资料 · 请勿外传' },
      ...runs,
      { x: MARGIN, y: 45, size: 8, text: `第 ${i + 1} 页 / 共 ${pages.length} 页` },
    ]
    return withChrome.sort((a, b) => b.y - a.y || a.x - b.x)
  })
}

/** PDF 文本串：用 UTF-16BE 十六进制写，这是 PDF 表示非 ASCII 文字的标准形式之一 */
function hexString(text: string): string {
  let hex = 'FEFF'
  const buf = Buffer.from(text, 'utf16le')
  for (let i = 0; i + 1 < buf.length; i += 2) {
    hex += buf[i + 1].toString(16).padStart(2, '0') + buf[i].toString(16).padStart(2, '0')
  }
  return `<${hex}>`
}

/** 手写一个最小 PDF：目录 → 页树 → 每页一个内容流，末尾是交叉引用表 */
function buildPdf(pages: PlacedRun[][]): Buffer {
  const objects: string[] = []
  const pageIds = pages.map((_, i) => 3 + i * 2)
  const fontId = 3 + pages.length * 2

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`

  pages.forEach((runs, i) => {
    const pageId = pageIds[i]
    const contentId = pageId + 1
    const stream = runs
      .map(
        (r) =>
          `BT\n/F1 ${r.size} Tf\n1 0 0 1 ${r.x.toFixed(2)} ${r.y.toFixed(2)} Tm\n${hexString(r.text)} Tj\nET`
      )
      .join('\n')
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  // 没有嵌入字体文件：我们只需要文本层可解析，不需要它在阅读器里显示字形
  objects[fontId] = '<< /Type /Font /Subtype /Type0 /BaseFont /Noto /Encoding /Identity-H >>'

  let out = '%PDF-1.7\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out, 'latin1')
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/**
 * 扫描件：整页是一张图，文本层里除了页眉页脚一个字都没有。
 * 这正是「空文本比例」这条断言要抓的东西——抓到了就该转 OCR。
 */
function blankScanPages(count: number): PlacedRun[][] {
  return Array.from({ length: count }, (_, i) => [
    { x: MARGIN, y: 805, size: 8, text: '云梯科技 · 内部资料 · 请勿外传' },
    { x: MARGIN, y: 45, size: 8, text: `第 ${i + 1} 页 / 共 ${count} 页` },
  ])
}

/** Markdown 正文 → PDF 排版块：标题按字号区分，其余按行 */
function toBlocks(doc: Doc): Block[] {
  const blocks: Block[] = []
  for (const raw of doc.body.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ size: heading[1].length === 1 ? 17 : 14, text: heading[2] })
    } else {
      blocks.push({ size: 10, text: line })
    }
  }
  return blocks
}

// ---------------------------------------------------------------- HTML 与扫描件

/** 造一个「像真网页」的 HTML：有导航、侧栏、脚注、代码块、相对链接和统计脚本 */
function toHtml(doc: Doc): string {
  const body = doc.body
    .split('\n\n')
    .map((chunk) => {
      const heading = /^(#{1,6})\s+(.*)$/.exec(chunk.trim())
      if (heading) {
        const level = Math.min(heading[1].length, 3)
        return `    <h${level}>${heading[2]}</h${level}>`
      }
      const text = chunk
        .trim()
        .replace(/\n/g, ' ')
        .replace(/任务板/, '<a href="./doc-001.md">任务板</a>')
      return `    <p>${text}</p>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${doc.title} · 云梯科技帮助中心</title>
  <script>window.__track = function () { /* 站点统计脚本，正文里一个字都不该留 */ }</script>
</head>
<body>
  <nav class="site-nav">
    <a href="/">首页</a> · <a href="/docs">帮助中心</a> · <a href="/pricing">定价</a> · <a href="/login">登录</a>
  </nav>
  <main>
${body}
    <pre><code>curl -X POST https://api.example.com/v1/boards \\
  -H "Content-Type: application/json" \\
  -d '{"name": "新任务板"}'</code></pre>
    <p>更多字段说明见<a href="./doc-002.md">文档协作与版本历史</a><sup id="ref-1"><a href="#fn-1">[1]</a></sup>。</p>
    <section class="footnotes">
      <p id="fn-1">[1] 企业版才支持跨任务板依赖，详见套餐对照表。</p>
    </section>
  </main>
  <aside class="related">
    <h3>相关文档</h3>
    <ul><li><a href="/docs/doc-001">产品总览</a></li><li><a href="/docs/doc-002">版本历史</a></li></ul>
  </aside>
  <footer>© 2026 云梯科技 · 沪ICP备00000000号 · <a href="/terms">服务条款</a></footer>
</body>
</html>
`
}

/**
 * 扫描件走 OCR 之后的样子：**结构全丢**（没有标题标记、没有段落边界），
 * 而且带一批形近字错误。这里的错字是确定性注入的，跑多少次都一样。
 */
const OCR_CONFUSIONS: Array<[string, string]> = [
  ['已', '己'],
  ['未', '末'],
  ['日', '曰'],
  ['千', '干'],
  ['体', '休'],
  ['板', '版'],
  ['件', '伴'],
  ['0', 'O'],
  ['1', 'l'],
  ['5', 'S'],
]

export function toOcrText(doc: Doc): { text: string; errorRate: number } {
  const flat = doc.body
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .join('')
  const map = new Map(OCR_CONFUSIONS)
  let errors = 0
  let seen = 0
  const chars = [...flat].map((ch) => {
    const wrong = map.get(ch)
    if (!wrong) return ch
    seen += 1
    if (seen % 2 === 0) return ch // 隔一个错一个，别把整篇糊掉
    errors += 1
    return wrong
  })
  // 再模拟一处最典型的「整行漏识别」：中间挖掉一小段
  const text = chars.join('')
  return { text, errorRate: errors / Math.max(1, chars.length) }
}

// ---------------------------------------------------------------- 入口

export interface SampleSet {
  htmlDocId: string
  pdfSingleDocId: string
  pdfTwoColumnDocId: string
  ocrDocId: string
  ocrErrorRate: number
}

export function makeSamples(): SampleSet {
  const docs = loadCorpus()
  mkdirSync(SAMPLES_DIR, { recursive: true })

  const htmlDoc = getDoc(docs, 'doc-003')
  writeFileSync(join(SAMPLES_DIR, 'doc-003.html'), toHtml(htmlDoc), 'utf8')

  // 单栏 PDF：排版正常，用来确认解析器在「简单情况」下是对的
  const singleDoc = getDoc(docs, 'doc-019')
  writeFileSync(join(SAMPLES_DIR, 'doc-019.pdf'), buildPdf(layout(toBlocks(singleDoc), 1, 18)))

  // 双栏 PDF：语料里那份表格本来就串行，再压进两栏——本天最难的一份
  const twoColDoc = getDoc(docs, 'doc-005')
  writeFileSync(join(SAMPLES_DIR, 'doc-005.pdf'), buildPdf(layout(toBlocks(twoColDoc), 2, 22)))

  // 扫描件：先给一份没有文本层的 PDF，再给它「送去 OCR」之后的纯文本
  const ocrDoc = getDoc(docs, 'doc-024')
  writeFileSync(join(SAMPLES_DIR, 'doc-024.scan.pdf'), buildPdf(blankScanPages(2)))
  const ocr = toOcrText(ocrDoc)
  writeFileSync(join(SAMPLES_DIR, 'doc-024.ocr.txt'), ocr.text, 'utf8')

  return {
    htmlDocId: htmlDoc.id,
    pdfSingleDocId: singleDoc.id,
    pdfTwoColumnDocId: twoColDoc.id,
    ocrDocId: ocrDoc.id,
    ocrErrorRate: ocr.errorRate,
  }
}
