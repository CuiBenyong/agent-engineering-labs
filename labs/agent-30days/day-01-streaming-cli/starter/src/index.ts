import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

type Role = 'system' | 'user' | 'assistant'

interface Message {
  role: Role
  content: string
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini'

async function* streamChat(messages: Message[]): AsyncGenerator<string> {
  if (process.env.MOCK === '1') {
    const canned = '这是离线模拟回复：实现下面的练习后，去掉 MOCK=1 试试真模型。'
    for (const ch of canned) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      yield ch
    }
    return
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY（或用 MOCK=1 离线运行）')

  // 练习 1：用 fetch 向 API_URL 发 POST，body 里带 model / messages / stream: true /
  //         stream_options: { include_usage: true }，Header 带 Authorization: Bearer <apiKey>。
  // 练习 2：用 res.body.getReader() 逐块读取，用 TextDecoder 解码，按 "\n" 切行；
  //         只处理以 "data: " 开头的行，遇到 "data: [DONE]" 结束。
  // 练习 3：每行 JSON.parse 成 StreamChunk，把 choices[0].delta.content 用 yield 交出去；
  //         如果 chunk.usage 存在，打印 prompt/completion token 数。
  // 提示：半行问题——最后一段可能还没到换行符，留到下一轮再拼。
  void messages
  void API_URL
  void MODEL
  const unused: StreamChunk | null = null
  void unused
  throw new Error('练习：在这里实现 fetch + SSE 解析（参考 solution/src/index.ts）')
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
    // 练习 4：把模型的回复也 push 进 messages，否则下一轮模型会"忘记"刚说过什么。
    void reply
  }
  rl.close()
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
