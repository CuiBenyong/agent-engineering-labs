import type { Doc } from './corpus.js'
import { chunkId, contentHash, type ParsedDoc, type ParsedNode } from './types.js'

/**
 * 标题栈：把「当前读到第几级标题、各级分别是什么」维护成一个数组。
 * 读到 level 级标题时，先把栈截到 level-1 长，再把自己放进去——
 * 这一步保证从 h3 跳回 h2 时，h3 那一层会被正确丢掉。
 */
export function pushHeading(stack: string[], level: number, title: string): string[] {
  // 练习 1：维护标题栈，返回读到这一级标题之后的完整标题路径。
  // 提示：先把栈截到 level-1 长（从 h3 退回 h2 时，h3 那一层必须被丢掉），
  //       再把自己接上去；层级跳跃（h1 直接到 h3）时中间要补空位，否则路径会错层。
  // 现在的实现永远返回空数组，跑起来你会看到所有节点都是「（无标题路径）」——
  // 这意味着 D6 的引用没法告诉用户「这句话出自哪一节」。
  void stack
  void level
  void title
  return []
}

interface Meta {
  docId: string
  department: Doc['department']
  updatedAt: string
  contentHash: string
}

function makeNode(meta: Meta, index: number, text: string, headingPath: string[]): ParsedNode {
  return {
    docId: meta.docId,
    chunkId: chunkId(meta.docId, index),
    text,
    headingPath: [...headingPath],
    page: null, // Markdown 与 HTML 没有页码概念，写 null，不要写 0 也不要留 undefined
    department: meta.department,
    updatedAt: meta.updatedAt,
    contentHash: meta.contentHash,
  }
}

/**
 * Markdown 解析：按空行切块，标题不单独成节点而是变成后续节点的 headingPath。
 * 代码围栏内部的空行不切块——这是最容易漏的一条，漏了会把一段 shell 命令
 * 拆成互不相干的三块。
 */
export function parseMarkdown(doc: Doc): ParsedDoc {
  const hash = contentHash(doc.raw)
  const meta: Meta = {
    docId: doc.id,
    department: doc.department,
    updatedAt: doc.updated,
    contentHash: hash,
  }

  const nodes: ParsedNode[] = []
  let headingPath: string[] = []
  let buffer: string[] = []
  let inFence = false

  const flush = () => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (text) nodes.push(makeNode(meta, nodes.length, text, headingPath))
  }

  for (const raw of doc.body.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      buffer.push(line)
      if (!inFence) flush() // 围栏闭合就自成一块
      continue
    }
    if (inFence) {
      buffer.push(line)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      headingPath = pushHeading(headingPath, heading[1].length, heading[2].trim())
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()

  return {
    docId: doc.id,
    title: doc.title,
    source: 'markdown',
    department: doc.department,
    updatedAt: doc.updated,
    contentHash: hash,
    nodes,
  }
}

/**
 * 扫描件走 OCR 之后拿到的是一大坨纯文本：没有标题标记、没有段落边界。
 * 只能按句号硬切，headingPath 一律空——**结构一旦在纸上丢了，代码补不回来**。
 */
export function parsePlainText(doc: Doc, text: string, source: 'ocr'): ParsedDoc {
  const hash = contentHash(text)
  const meta: Meta = {
    docId: doc.id,
    department: doc.department,
    updatedAt: doc.updated,
    contentHash: hash,
  }
  const sentences = text.split(/(?<=[。！？])/).filter((s) => s.trim())
  const nodes: ParsedNode[] = []
  let buffer: string[] = []
  for (const sentence of sentences) {
    buffer.push(sentence)
    if (buffer.join('').length >= 180) {
      nodes.push(makeNode(meta, nodes.length, buffer.join(''), []))
      buffer = []
    }
  }
  if (buffer.length) nodes.push(makeNode(meta, nodes.length, buffer.join(''), []))

  return {
    docId: doc.id,
    title: doc.title,
    source,
    department: doc.department,
    updatedAt: doc.updated,
    contentHash: hash,
    nodes,
  }
}
