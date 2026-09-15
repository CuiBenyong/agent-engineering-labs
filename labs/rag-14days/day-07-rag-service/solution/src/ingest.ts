import type { RagConfig } from './config'
import type { EmbeddingBackend } from './embed'
import { createChunker, loadDocs } from './pipeline'
import type { Store } from './store'

/**
 * 摄取链路的编排：解析 → 切块 → 向量化 → 入库。四步各自是一个可替换的零件，
 * 这个函数只负责按顺序把它们串起来，不含任何解析或切块的具体知识。
 *
 * 换句话说：这里是**唯一**知道「摄取有四步」的地方。想插一步（比如 D11 的
 * 上下文块头生成），改这一个函数就够了。
 */
export interface IngestReport {
  docs: number
  chunks: number
  embeddingModel: string
  chunkStrategy: string
  ms: number
  perDoc: { docId: string; chunks: number; contentHash: string }[]
}

export async function ingest(
  dir: string,
  store: Store,
  cfg: RagConfig,
  embedder: EmbeddingBackend
): Promise<IngestReport> {
  const startedAt = Date.now()
  const docs = loadDocs(dir)
  const chunker = createChunker(cfg)
  const perDoc: IngestReport['perDoc'] = []
  let total = 0

  for (const doc of docs) {
    const chunks = chunker(doc)
    // 按文档批量向量化：接口版按次收费也按次限流，一块一次调用会又慢又贵。
    // 真到几万篇的规模还要再加并发与失败重试，那是 D13 的事。
    const vectors = await embedder.embed(chunks.map((c) => c.text))
    await store.replaceDoc(doc, chunks, vectors, embedder.name)
    perDoc.push({ docId: doc.docId, chunks: chunks.length, contentHash: doc.contentHash })
    total += chunks.length
  }

  return {
    docs: docs.length,
    chunks: total,
    embeddingModel: embedder.name,
    chunkStrategy: cfg.chunking.strategy,
    ms: Date.now() - startedAt,
    perDoc,
  }
}
