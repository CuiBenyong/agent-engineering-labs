/**
 * 离线剧本 provider。★ D2 定稿，之后十九天逐字不变。
 *
 * 它不是"打印一句假回复"：剧本可以要求调用工具，所以离线模式下 Agent 会真的
 * 读文件、真的改文件、真的跑测试——只有"模型说了什么"是假的，其余全是真的。
 *
 * 两条设计约束：
 *   1. 分支按"最后一条用户消息 + 已有的工具结果条数"选，不按轮数递增，
 *      否则注入故障后剧本就错位（第 N 轮拿到第 N+1 步的台词）。
 *   2. 事件序列必须与真实网关一致，包括末尾的 usage 与 finish。
 *      少一条，你在离线下调好的逻辑一上真模型就露馅。
 */
import type { ChatProvider, ChatRequest, StreamDelta } from './types.js'
import { contentToText } from '../kernel/types.js'
import { pickScene } from '../mock-script.js'
import { RateLimitError, StreamTruncatedError } from './gateway.js'

/** 每片吐几个字符：小一点才看得出"流"的形状 */
const CHUNK_SIZE = 4
const CHUNK_DELAY_MS = 12
/** 工具参数也要分片，模拟真实网关把 JSON 切开送达 */
const ARGS_CHUNK_SIZE = 12

/** 剧本里的一步：说一段话，也可以要求调用若干工具 */
export interface MockStep {
  text?: string
  toolCalls?: Array<{ id: string; name: string; args: unknown }>
}

export interface MockScene {
  name: string
  steps: MockStep[]
}

/** INJECT 是全课统一的故障开关，取值表见连贯性卡片 */
const inject = process.env.INJECT ?? ''
/** 限流注入只在第一次生效，第二次要成功——否则退避重试永远看不到成功那一支 */
let rateLimitFired = false

export class MockProvider implements ChatProvider {
  readonly id = 'mock'

  constructor(readonly model: string) {}

  async *stream(req: ChatRequest): AsyncIterable<StreamDelta> {
    if (inject === 'rate_limit' && !rateLimitFired) {
      rateLimitFired = true
      throw new RateLimitError(200)
    }

    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
    const toolResults = req.messages.filter((m) => m.role === 'tool').length
    const scene = pickScene(contentToText(lastUser?.content ?? ''), toolResults)
    const step = scene.steps[Math.min(toolResults, scene.steps.length - 1)] ?? {}

    let emitted = 0
    for (const piece of splitText(step.text ?? '')) {
      await sleep(CHUNK_DELAY_MS)
      emitted += 1
      yield { type: 'text', text: piece }
      // 断流注入：吐几片就把连接掐掉，且不发 finish
      if (inject === 'truncated' && emitted === 3) throw new StreamTruncatedError(emitted)
    }

    if (step.toolCalls?.length) {
      // index 故意从 1 开始：实测有的模型就是这样，归并代码必须按 index 建字典，
      // 不许假设从 0 起、不许按到达顺序 push 进数组。
      let index = 1
      for (const call of step.toolCalls) {
        const argsText =
          inject === 'bad_args'
            ? JSON.stringify(call.args).slice(0, 6) // 故意截断成非法 JSON
            : JSON.stringify(call.args)
        yield { type: 'tool_call', index, id: call.id, name: call.name }
        for (let i = 0; i < argsText.length; i += ARGS_CHUNK_SIZE) {
          await sleep(2)
          yield { type: 'tool_call', index, argsDelta: argsText.slice(i, i + ARGS_CHUNK_SIZE) }
        }
        index += 1
      }
      yield usageOf(req, step)
      yield { type: 'finish', reason: 'tool_calls' }
      return
    }

    yield usageOf(req, step)
    yield { type: 'finish', reason: 'stop' }
  }
}

function usageOf(req: ChatRequest, step: MockStep): StreamDelta {
  const promptText = req.messages.map((m) => contentToText(m.content)).join('')
  return {
    type: 'usage',
    promptTokens: estimateTokens(promptText),
    completionTokens: estimateTokens(step.text ?? ''),
    cachedTokens: 0,
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
