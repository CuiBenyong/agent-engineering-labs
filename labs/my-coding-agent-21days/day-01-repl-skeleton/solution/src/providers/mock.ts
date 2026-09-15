/**
 * 离线剧本 provider：不发任何网络请求，按剧本吐增量。
 *
 * 它不是"打印一句假回复"。剧本按最后一条用户消息选分支，
 * 所以后面几天注入故障、让模型调工具，离线也能看到真实现象。
 */
import type { ChatProvider, ChatRequest, StreamDelta } from './types.js'
import { contentToText } from '../kernel/types.js'
import { pickScene } from '../mock-script.js'

/** 每片吐几个字符：小一点才看得出"流"的形状 */
const CHUNK_SIZE = 4
const CHUNK_DELAY_MS = 12

export class MockProvider implements ChatProvider {
  readonly id = 'mock'

  constructor(readonly model: string) {}

  async *stream(req: ChatRequest): AsyncIterable<StreamDelta> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
    const scene = pickScene(contentToText(lastUser?.content ?? ''))

    for (const piece of splitText(scene.text)) {
      await sleep(CHUNK_DELAY_MS)
      yield { type: 'text', text: piece }
    }
    yield {
      type: 'usage',
      promptTokens: estimateTokens(req.messages.map((m) => contentToText(m.content)).join('')),
      completionTokens: estimateTokens(scene.text),
      cachedTokens: 0,
    }
    yield { type: 'finish', reason: 'stop' }
  }
}

function splitText(text: string): string[] {
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += CHUNK_SIZE) pieces.push(text.slice(i, i + CHUNK_SIZE))
  return pieces
}

/** 离线模式没有真实用量，用一个粗估算顶上；D12 会把这个估算器做正经 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 2))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
