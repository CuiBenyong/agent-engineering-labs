import { randomUUID } from 'node:crypto'

import { embed, embeddingCostUsd } from './infra/embeddings'
import type { SearchHit, Store } from './infra/store'

export const CHUNK_SIZE = 400 // 目标 400 字符：一张卡片只装一件事
export const OVERLAP = 80 // 重叠 80 字符：句子被切口劈开时，另一块里还留着完整的一份

/**
 * 练习 1：把长文按 CHUNK_SIZE 切块，相邻块重叠 OVERLAP 个字符。
 * 提示一：400 是目标不是硬上限——先取 start + CHUNK_SIZE，再往前找最近的「。」或换行
 *   当收尾点，但只在后半段找，否则块会被切得太小、反而丢上下文。
 * 提示二：下一块的起点是 end - OVERLAP，但必须保证 start 一定前进，否则死循环。
 * 现在原样返回整段：跑自检你会看到「1 块」，也就是根本没切——
 * 检索时命中的那张卡片横跨了所有主题，谁问什么都命中它。
 */
export function chunkText(text: string): string[] {
  return [text.trim()]
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
