import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

type Role = 'system' | 'user' | 'assistant'

interface Message {
  role: Role
  content: string
}

/** OpenRouter（OpenAI 兼容）流式响应里每个 data: 块的形状，只声明我们用到的字段 */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini'

/**
 * 把一次对话请求变成"一个个字符片段"的异步生成器。
 * 调用方只管 for await，不用关心 HTTP 和 SSE 的细节。
 */
async function* streamChat(messages: Message[]): AsyncGenerator<string> {
  if (process.env.MOCK === '1') {
    const canned =
      '这是离线模拟回复：去掉 MOCK=1 并在 .env 里配置 OPENROUTER_API_KEY，就能连上真模型。'
    for (const ch of canned) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      yield ch
    }
    return
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

  // SSE 是按行的文本协议：每条事件形如 "data: {...}\n\n"，结束是 "data: [DONE]"
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // 最后一段可能是半行，留到下一轮
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice('data: '.length).trim()
      if (data === '[DONE]') return
      const chunk = JSON.parse(data) as StreamChunk
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) yield delta
      if (chunk.usage) {
        stdout.write(
          `\n[usage] prompt=${chunk.usage.prompt_tokens} completion=${chunk.usage.completion_tokens}\n`
        )
      }
    }
  }
}

async function main(): Promise<void> {
  const messages: Message[] = [
    { role: 'system', content: '你是一个耐心的编程助教，回答简洁，必要时给出代码。' },
  ]
  const rl = readline.createInterface({ input: stdin, output: stdout })

  stdout.write(`模型：${MODEL}（输入 exit 退出）\n`)
  while (true) {
    let line: string
    try {
      line = (await rl.question('你> ')).trim()
    } catch {
      break // stdin 已经结束（比如管道喂完一行就关闭了），正常退出，不打断正在进行的流式输出
    }
    if (line === 'exit') break
    if (!line) continue

    messages.push({ role: 'user', content: line })
    stdout.write('助教> ')
    let reply = ''
    for await (const delta of streamChat(messages)) {
      stdout.write(delta)
      reply += delta
    }
    stdout.write('\n')
    messages.push({ role: 'assistant', content: reply }) // 历史要自己带上，模型没有记忆
  }
  rl.close()
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
