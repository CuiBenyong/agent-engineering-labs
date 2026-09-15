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

    // TODO(2) 把剧本文本切成小片吐出来，让"流"的形状肉眼可见。
    //
    // 要点：
    //   1. 用 splitText 切片，每片之间 await sleep(CHUNK_DELAY_MS)
    //   2. 每片 yield 一个 { type: 'text', text } 
    //   3. 文本吐完后补一条 usage（用 estimateTokens 估），再补一条 finish（reason 为 stop）
    //      —— 少了这两条，渲染层就看不到用量、循环也不知道该收尾了
    void scene
    throw new Error('TODO(2)：离线剧本还没开始吐分片')
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
