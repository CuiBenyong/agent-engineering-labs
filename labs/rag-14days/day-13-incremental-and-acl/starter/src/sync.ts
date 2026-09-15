import { chunkDocument, contentHash } from './chunk.js'
import type { Doc } from './corpus.js'
import type { DocRow, EmbeddedChunk } from './store.js'

/** sync 只依赖索引的这三个动作，不关心底下是 pgvector 还是内存实现 */
export interface IndexLike {
  upsertDoc(row: DocRow): Promise<void>
  replaceChunks(docId: string, rows: EmbeddedChunk[]): Promise<void>
  deleteDoc(docId: string): Promise<void>
}

export type EmbedFnLike = (texts: string[]) => Promise<number[][]>

/**
 * 增量同步。全部逻辑就一句话：**拿来源的全集和索引的全集对账，只动对不上的那部分。**
 *
 * 三种变更必须都处理：
 *   新增  来源有、索引没有            → 切块、向量化、写入
 *   修改  两边都有但指纹不同          → 整篇替换（先删旧块再写新块）
 *   删除  索引有、来源没有            → 从索引里删掉，连带块与向量
 *
 * 删除是最容易漏的一种，因为它**不是一个事件，而是一个缺席**。
 * 只监听「文件变动」的同步器永远等不到这个事件：没人会给你发一条「我不存在了」的通知。
 */

export interface SyncPlan {
  added: string[]
  modified: string[]
  unchanged: string[]
  deleted: string[]
  /** docId → 正本 docId：正文完全相同的重复件，只索引正本 */
  duplicates: Array<{ docId: string; canonicalOf: string }>
}

export interface SyncOptions {
  /**
   * 关掉它就退化成「只处理来源里出现过的文档」——也就是绝大多数一开始写出来的同步器。
   * 这个开关只为了在实验里把幽灵现象跑出来，生产代码里不该存在。
   */
  detectDeletes: boolean
  dedupe: boolean
}

/**
 * 对账。注意两个指纹算的范围不一样，这是刻意的：
 *
 *   contentHash(doc.raw)   —— 变更检测。整份文件（含 frontmatter），文件里任何一个字变了都算变。
 *   contentHash(doc.body)  —— 去重。只算正文，剥掉 id、路径这类跟来源绑定的元信息，
 *                             这样「同一份内容被另存成另一个文件名」才认得出来。
 *
 * 用同一个指纹干这两件事是个常见的坑：拿整份文件去重，重复件永远认不出来；
 * 拿正文做变更检测，改了标题或部门标签却不会触发重算。
 */
export function planSync(
  indexed: Map<string, DocRow>,
  incoming: Doc[],
  opts: SyncOptions
): SyncPlan {
  const plan: SyncPlan = { added: [], modified: [], unchanged: [], deleted: [], duplicates: [] }
  const seenBody = new Map<string, string>() // 正文指纹 → 正本 docId

  for (const doc of [...incoming].sort((a, b) => a.id.localeCompare(b.id))) {
    if (opts.dedupe) {
      const bodyKey = contentHash(doc.body)
      const canonical = seenBody.get(bodyKey)
      if (canonical) {
        plan.duplicates.push({ docId: doc.id, canonicalOf: canonical })
        continue
      }
      seenBody.set(bodyKey, doc.id)
    }
    const known = indexed.get(doc.id)
    if (!known) plan.added.push(doc.id)
    else if (known.contentHash !== contentHash(doc.raw)) plan.modified.push(doc.id)
    else plan.unchanged.push(doc.id)
  }

  if (opts.detectDeletes) {
    // 练习 2：找出「索引里有、来源里没有」的文档，填进 plan.deleted。
    // 现在这一版只处理来源里出现过的文档，于是被删掉的那篇会永远留在索引里——
    // 它不报错，只是会在别人的检索结果里继续出现。改完看自测第 2、4 项。
    // 提示：把 incoming 的 id 装进一个 Set，再遍历 indexed 的 key。
  }
  return plan
}

export interface SyncResult {
  plan: SyncPlan
  /** 真正重新切块并向量化的块数——这就是这次同步的账单 */
  embeddedChunks: number
  /** 如果走全量重建要向量化多少块，用来算省了多少 */
  fullRebuildChunks: number
}

/** 把计划落到索引上。顺序是：先删、再改、后加——删在最前面，索引任何一刻都不会同时存在新旧两份 */
export async function applySync(
  store: IndexLike,
  embed: EmbedFnLike,
  incoming: Doc[],
  plan: SyncPlan
): Promise<SyncResult> {
  const byId = new Map(incoming.map((doc) => [doc.id, doc]))
  let embedded = 0

  for (const docId of plan.deleted) await store.deleteDoc(docId)

  for (const docId of [...plan.modified, ...plan.added]) {
    const doc = byId.get(docId)
    if (!doc) continue
    const chunks = chunkDocument(doc)
    const vectors = await embed(chunks.map((c) => c.text))
    await store.upsertDoc({
      docId: doc.id,
      title: doc.title,
      department: doc.department,
      updatedAt: doc.updated,
      contentHash: contentHash(doc.raw),
      canonicalOf: null,
    })
    await store.replaceChunks(
      doc.id,
      chunks.map((chunk, i) => ({ chunk, embedding: vectors[i] }))
    )
    embedded += chunks.length
  }

  // 重复件只登记一行元数据，不切块、不向量化。检索命中正本时可以顺带告诉用户
  // 「同样的内容在 doc-032 也有一份」，但索引里只有一份，钱也只花一份。
  for (const dup of plan.duplicates) {
    const doc = byId.get(dup.docId)
    if (!doc) continue
    await store.upsertDoc({
      docId: doc.id,
      title: doc.title,
      department: doc.department,
      updatedAt: doc.updated,
      contentHash: contentHash(doc.raw),
      canonicalOf: dup.canonicalOf,
    })
  }

  const fullRebuildChunks = incoming.reduce((sum, doc) => sum + chunkDocument(doc).length, 0)
  return { plan, embeddedChunks: embedded, fullRebuildChunks }
}
