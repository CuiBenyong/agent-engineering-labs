import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDoc, loadCorpus } from './corpus.js'
import { SAMPLES_DIR, makeSamples } from './make-samples.js'
import { parseHtml } from './parse-html.js'
import { parseMarkdown, parsePlainText } from './parse-md.js'
import { parsePdf } from './parse-pdf.js'
import { countCollapsedTables, probeHits, reconstruct, runChecks, type Check } from './quality.js'
import { contentHash, type ParsedDoc, type ParsedNode } from './types.js'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'out')

function title(text: string): void {
  console.log(`\n${'─'.repeat(64)}\n${text}\n${'─'.repeat(64)}`)
}

function printChecks(label: string, checks: Check[]): void {
  for (const c of checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${label} ${c.name}：${c.value}（阈值 ${c.limit}）`)
  }
}

function preview(node: ParsedNode | undefined, max = 46): string {
  if (!node) return '（没有节点）'
  const path = node.headingPath.length ? node.headingPath.join(' / ') : '（无标题路径）'
  const text = node.text.replace(/\s+/g, ' ')
  return `[${node.chunkId}] p${node.page ?? '-'} 《${path}》 ${text.slice(0, max)}…`
}

/** 把几个节点首尾相接地读出来，用来看同一批文字在两种阅读顺序下拼成了什么 */
function joinTexts(nodes: ParsedNode[]): string {
  return nodes.map((n) => n.text.replace(/\s+/g, ' ').slice(0, 30)).join(' ⟩ ')
}

function main(): void {
  const docs = loadCorpus()
  const samples = makeSamples()
  console.log(`语料 ${docs.length} 篇，样例已生成到 ${SAMPLES_DIR}`)

  const allChecks: Array<{ label: string; checks: Check[] }> = []
  /** 正式产物：30 篇 Markdown 原件。其余三条来源是同一批文档的另一种载体，只用来演示 */
  const allNodes: ParsedNode[] = []
  const demoNodes: ParsedNode[] = []
  const collect = (doc: ParsedDoc) => demoNodes.push(...doc.nodes)

  // ---------------------------------------------------------------- Markdown
  title('① Markdown：结构最全的一种来源')
  const parsedMd = docs.map((d) => parseMarkdown(d))
  for (const doc of parsedMd) allNodes.push(...doc.nodes)
  const withPath = allNodes.filter((n) => n.headingPath.length > 0).length
  console.log(
    `  ${parsedMd.length} 篇解析出 ${allNodes.length} 个节点，其中 ${withPath} 个带标题路径`
  )
  console.log(`  示例 ${preview(parsedMd[2].nodes[1])}`)
  const badTable = parsedMd.filter((d) => countCollapsedTables(d.nodes) > 0)
  console.log(`  塌陷表格命中：${badTable.map((d) => d.docId).join('、') || '无'}`)
  const mdChecks = runChecks({ doc: parsedMd.find((d) => d.docId === 'doc-005') as ParsedDoc })
  printChecks('doc-005(md)', mdChecks)
  allChecks.push({ label: 'doc-005 (markdown)', checks: mdChecks })

  // ---------------------------------------------------------------- HTML
  title('② HTML：好解析，但一半内容不该进正文')
  const htmlDoc = getDoc(docs, samples.htmlDocId)
  const html = readFileSync(join(SAMPLES_DIR, 'doc-003.html'), 'utf8')
  const parsedHtml = parseHtml(htmlDoc, html)
  collect(parsedHtml)
  console.log(`  ${parsedHtml.nodes.length} 个节点；导航、侧栏、页脚、统计脚本已整块丢弃`)
  console.log(`  示例 ${preview(parsedHtml.nodes[0])}`)
  const linkNode = parsedHtml.nodes.find((n) => n.text.includes('链接：'))
  console.log(`  相对链接保住了：${linkNode?.text.slice(0, 52) ?? '（没保住）'}`)
  const htmlChecks = runChecks({ doc: parsedHtml })
  printChecks('doc-003(html)', htmlChecks)
  allChecks.push({ label: 'doc-003 (html)', checks: htmlChecks })

  // ---------------------------------------------------------------- PDF 单栏
  title('③ PDF 单栏：页码、页眉页脚与按字号认标题')
  const singleDoc = getDoc(docs, samples.pdfSingleDocId)
  const singlePdf = readFileSync(join(SAMPLES_DIR, 'doc-019.pdf'))
  const parsedSingle = parsePdf(singleDoc, singlePdf)
  collect(parsedSingle)
  console.log(
    `  ${parsedSingle.pageCount} 页 / ${parsedSingle.nodes.length} 个节点，剔除页眉页脚 ${parsedSingle.chromeDropped} 条`
  )
  console.log(`  示例 ${preview(parsedSingle.nodes[1])}`)
  const singleChecks = runChecks({ doc: parsedSingle, orderSuspicion: parsedSingle.orderSuspicion })
  printChecks('doc-019(pdf)', singleChecks)
  allChecks.push({ label: 'doc-019 (pdf 单栏)', checks: singleChecks })

  // ---------------------------------------------------------------- PDF 双栏
  title('④ PDF 双栏：内容流顺序不可信')
  const twoColDoc = getDoc(docs, samples.pdfTwoColumnDocId)
  const twoColPdf = readFileSync(join(SAMPLES_DIR, 'doc-005.pdf'))
  // 先照内容流原序读一遍——这就是「直接用库给的顺序」的效果
  const naive = parsePdf(twoColDoc, twoColPdf, (runs) => runs)
  console.log(
    `  按内容流原序：${naive.nodes.length} 个节点，乱序疑似度 ${naive.orderSuspicion.toFixed(2)}`
  )
  console.log(`  顺着读前四段：${joinTexts(naive.nodes.slice(0, 4))}`)
  const fixed = parsePdf(twoColDoc, twoColPdf)
  collect(fixed)
  console.log(
    `  分栏排序后：${fixed.nodes.length} 个节点，乱序疑似度 ${fixed.orderSuspicion.toFixed(2)}`
  )
  console.log(`  顺着读前四段：${joinTexts(fixed.nodes.slice(0, 4))}`)
  const naiveChecks = runChecks({ doc: naive, orderSuspicion: naive.orderSuspicion })
  printChecks('doc-005(pdf 原序)', naiveChecks)
  const fixedChecks = runChecks({ doc: fixed, orderSuspicion: fixed.orderSuspicion })
  printChecks('doc-005(pdf 修复后)', fixedChecks)
  allChecks.push({ label: 'doc-005 (pdf 双栏·原序)', checks: naiveChecks })
  allChecks.push({ label: 'doc-005 (pdf 双栏·修复后)', checks: fixedChecks })

  // ---------------------------------------------------------------- 扫描件
  title('⑤ 扫描件：先被断言拦住，再走 OCR')
  const ocrDoc = getDoc(docs, samples.ocrDocId)
  const scanPdf = readFileSync(join(SAMPLES_DIR, 'doc-024.scan.pdf'))
  const parsedScan = parsePdf(ocrDoc, scanPdf)
  console.log(`  ${parsedScan.pageCount} 页，正文节点 ${parsedScan.nodes.length} 个——文本层是空的`)
  const scanChecks = runChecks({ doc: parsedScan, orderSuspicion: parsedScan.orderSuspicion })
  printChecks('doc-024(scan)', scanChecks)
  allChecks.push({ label: 'doc-024 (扫描件 pdf)', checks: scanChecks })

  const ocrText = readFileSync(join(SAMPLES_DIR, 'doc-024.ocr.txt'), 'utf8')
  const parsedOcr = parsePlainText(ocrDoc, ocrText, 'ocr')
  collect(parsedOcr)
  const cleanMd = parsedMd.find((d) => d.docId === ocrDoc.id) as ParsedDoc
  console.log(
    `  转 OCR 后拿到 ${parsedOcr.nodes.length} 个节点，错字率 ${(samples.ocrErrorRate * 100).toFixed(1)}%`
  )
  console.log(
    `  术语命中：Markdown 原件 ${probeHits(ocrDoc.title, reconstruct(cleanMd))} 次，` +
      `OCR 版 ${probeHits(ocrDoc.title, reconstruct(parsedOcr))} 次`
  )
  console.log('  标题路径全空——纸上没有的结构，代码补不回来')

  // ---------------------------------------------------------------- 元数据
  title('⑥ 元数据自检与内容指纹')
  const ids = new Set(allNodes.map((n) => n.chunkId))
  const missing = [...allNodes, ...demoNodes].filter(
    (n) => !n.department || !n.updatedAt || !n.contentHash
  )
  console.log(
    `  产物 ${allNodes.length} 个节点，chunkId 唯一：${ids.size === allNodes.length ? '是' : '否'}`
  )
  console.log(`  元数据缺字段的节点：${missing.length} 个`)
  console.log(
    `  另有 ${demoNodes.length} 个节点来自 HTML / PDF / OCR 三条演示路径，不并进产物——` +
      '同一篇文档在生产里只保留一条来源，否则 chunkId 必然相撞'
  )
  for (const doc of [cleanMd, parsedHtml, fixed]) {
    console.log(`  ${doc.docId}（${doc.source}）指纹 ${doc.contentHash}`)
  }
  const tweaked = contentHash(`${getDoc(docs, cleanMd.docId).raw}（补一句话）`)
  console.log(`  给 ${cleanMd.docId} 末尾补一句话之后：${tweaked}（D13 就靠这个判断要不要重算）`)

  // ---------------------------------------------------------------- 汇总
  title('⑦ 质量报告')
  for (const { label, checks } of allChecks) {
    const failed = checks.filter((c) => !c.ok)
    console.log(
      `  ${failed.length === 0 ? '✅' : '❌'} ${label}${failed.length ? `　越线：${failed.map((c) => c.name).join('、')}` : ''}`
    )
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'nodes.json'), `${JSON.stringify(allNodes, null, 2)}\n`, 'utf8')
  console.log(
    `\n共 ${allNodes.length} 个节点已写入 ${join(OUT_DIR, 'nodes.json')}，D4 的切块直接读它。`
  )
}

main()
