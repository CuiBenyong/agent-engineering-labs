import { createHash } from 'node:crypto'

export type Department = 'product' | 'hr' | 'eng' | 'support'

/** 四种来源：Markdown 原件、HTML 页面、PDF 文本层、扫描件走 OCR 之后的纯文本 */
export type SourceKind = 'markdown' | 'html' | 'pdf' | 'ocr'

/**
 * 全课统一的解析产物节点。字段名在 14 天里不变——D4 的切块、D6 的引用、
 * D13 的权限过滤与增量同步全都直接读这几个字段，改名等于改全课的契约。
 */
export interface ParsedNode {
  /** 对应语料 frontmatter 的 id，如 doc-005 */
  docId: string
  /** 节点在本文档内的编号，形如 doc-005#c07 */
  chunkId: string
  /** 节点正文，已经过清洗 */
  text: string
  /** 从一级标题往下的标题路径，如 ["套餐与配额对照表", "文字说明"] */
  headingPath: string[]
  /** 只有 PDF 来源有页码，其余来源一律 null */
  page: number | null
  /** 权限标签，D13 的访问控制过滤直接用它 */
  department: Department
  /** 文档的更新日期（ISO），D13 判新旧用 */
  updatedAt: string
  /** 整篇文档的内容指纹，同一篇文档的所有节点共享同一个值 */
  contentHash: string
}

export interface ParsedDoc {
  docId: string
  title: string
  source: SourceKind
  department: Department
  updatedAt: string
  contentHash: string
  nodes: ParsedNode[]
}

/**
 * 内容指纹：整篇文档原文的 sha256 前 16 位。
 *
 * 两个刻意的决定：
 * 1. 指纹算在**整篇文档**上，不是算在每个节点上。D13 的增量同步先用它判断
 *    「这篇要不要重算」，判断为要，才会去比对节点级的差异。
 * 2. 先做换行归一化再算。同一份文档从 Windows 机器上传一次、从 Mac 上传一次，
 *    字节不同但内容相同——不归一化的话每次同步都会判定成「变了」，白重算一遍全库。
 */
export function contentHash(raw: string): string {
  // 练习 4：算出这篇文档的内容指纹。
  // 提示：先把 \r\n 归一成 \n 再 trim（同一份文档在不同系统上传，字节不同但内容相同，
  //       不归一化的话每次同步都会判定成「变了」），然后 sha256 取十六进制前 16 位。
  // 现在所有文档共用同一个假指纹，D13 的增量同步会得出「一篇都没变」的结论。
  void raw
  return '0000000000000000'
}

/** 节点编号统一形如 doc-005#c07，两位补零，方便肉眼排序 */
export function chunkId(docId: string, index: number): string {
  return `${docId}#c${String(index + 1).padStart(2, '0')}`
}
