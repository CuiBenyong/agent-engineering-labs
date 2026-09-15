/**
 * 全课唯一的 provider 选择点。★ D1 定稿，之后二十天逐字不变。
 *
 * 只看一个环境变量：MOCK=1 走离线剧本，其余走真实网关。
 * 选择点只有一处，是为了让"离线也能跑"这件事不散落在二十一天的代码里。
 */
import type { ChatProvider } from './types.js'
import { GatewayProvider } from './gateway.js'
import { MockProvider } from './mock.js'
import { loadConfig } from '../config.js'

export function createProvider(): ChatProvider {
  const config = loadConfig()
  if (config.mock) return new MockProvider(config.model)
  if (!config.apiKey) {
    throw new Error(
      '缺少 LLM_API_KEY。要么在 .env 里填一个，要么加 MOCK=1 用离线剧本跑（离线不发任何网络请求）。'
    )
  }
  return new GatewayProvider(config.baseUrl, config.apiKey, config.model)
}

export type { ChatProvider, ChatRequest, StreamDelta } from './types.js'
