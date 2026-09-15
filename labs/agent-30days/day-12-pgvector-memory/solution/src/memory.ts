import { randomUUID } from 'node:crypto'

import { embed, embeddingCostUsd } from './infra/embeddings'
import type { SearchHit, Store } from './infra/store'

export const CHUNK_SIZE = 400 // 目标 400 字符：一张卡片只装一件事
export const OVERLAP = 80 // 重叠 80 字符：句子被切口劈开时，另一块里还留着完整的一份

/** 切块。400 是目标不是硬上限：优先在句号、换行这些自然边界收尾，别把一句话劈成两半。 */
export function chunkText(text: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length)
    if (end < text.length) {
      // 只在后半段找边界：在前半段收尾会把块切得太小，反而丢上下文
      const half = start + Math.floor(CHUNK_SIZE / 2)
      const window = text.slice(half, end)
      const hit = Math.max(window.lastIndexOf('。'), window.lastIndexOf('\n'))
      if (hit >= 0) end = half + hit + 1
    }

    const piece = text.slice(start, end).trim()
    if (piece.length > 0) chunks.push(piece)
    if (end >= text.length) break
    // 回退 OVERLAP 制造重叠，同时保证 start 一定前进——否则死循环
    start = Math.max(end - OVERLAP, start + 1)
  }
  return chunks
}

// 写入流程：切块 → 批量算 embedding → 落库。生产里前面还该有一步：让模型把对话抽成
// 陈述句再切块，否则「嗯」「你帮我看看」这类没有信息量的句子会把向量拉平。
export async function ingest(
  store: Store,
  userId: string,
  sourceRunId: string | null,
  text: string
): Promise<{ chunks: number; costUsd: number }> {
  const chunks = chunkText(text)
  if (chunks.length === 0) return { chunks: 0, costUsd: 0 }

  const vectors = await embed(chunks)
  const createdAt = new Date().toISOString()
  await store.insert(
    chunks.map((content, index) => ({
      id: randomUUID(),
      userId,
      sourceRunId,
      content,
      embedding: vectors[index],
      createdAt,
    }))
  )

  return { chunks: chunks.length, costUsd: embeddingCostUsd(chunks) }
}

/** 检索：query 也要过一次 embedding，才能和库里的向量比距离。 */
export async function searchMemories(
  store: Store,
  userId: string,
  query: string,
  limit: number
): Promise<SearchHit[]> {
  const [vector] = await embed([query])
  return store.search(userId, vector, limit)
}
